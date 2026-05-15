// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseHook} from "@uniswap/v4-periphery/src/utils/BaseHook.sol";
import {Hooks} from "@uniswap/v4-periphery/lib/v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "@uniswap/v4-periphery/lib/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-periphery/lib/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IERC20Minimal} from "@uniswap/v4-periphery/lib/v4-core/src/interfaces/external/IERC20Minimal.sol";
import {PoolKey} from "@uniswap/v4-periphery/lib/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-periphery/lib/v4-core/src/types/PoolOperation.sol";
import {BeforeSwapDelta, toBeforeSwapDelta} from "@uniswap/v4-periphery/lib/v4-core/src/types/BeforeSwapDelta.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-periphery/lib/v4-core/src/types/Currency.sol";
import {TransientStateLibrary} from "@uniswap/v4-periphery/lib/v4-core/src/libraries/TransientStateLibrary.sol";
import {ShadowMeshSwapRouter} from "./ShadowMeshSwapRouter.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @title ShadowMeshHook
/// @notice Uniswap v4 JIT OTC dark pool hook for AI-negotiated intents.
/// @dev Keeper calls `executeDarkPoolSwap` → `unlock` → swap router → `beforeSwap` OTC → buyer/seller settlement in callback.
contract ShadowMeshHook is BaseHook, EIP712, Ownable2Step, Nonces, IUnlockCallback {
    using CurrencyLibrary for Currency;
    using TransientStateLibrary for IPoolManager;

    struct DarkPoolIntent {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        int24 tickSpacing;
        uint256 amountIn;
        uint256 amountOut;
        address buyer;
        address seller;
        uint256 buyerNonce;
        uint256 sellerNonce;
        uint256 deadline;
    }

    address public authorizedKeeper;

    /// @notice Thin router that calls `poolManager.swap` so `beforeSwap` runs (v4 skips hook self-calls).
    address public swapRouter;

    /// @notice PoolManager passes the outer swap `sender` (ShadowMeshSwapRouter), not the keeper EOA.
    mapping(address => bool) public allowedSwapSender;

    bytes32 private constant INTENT_TYPEHASH =
        keccak256(
            "DarkPoolIntent(address tokenIn,address tokenOut,uint24 fee,int24 tickSpacing,uint256 amountIn,uint256 amountOut,address buyer,address seller,uint256 buyerNonce,uint256 sellerNonce,uint256 deadline)"
        );

    error SwapSenderNotAllowed(address sender);
    error InvalidAISignature();
    error IntentExpired(uint256 deadline);
    error InvalidIntent();
    error InvalidSwap();
    error ExactOutputUnsupported();
    error AmountTooLarge(uint256 amount);
    error SellerTransferFailed(address token, address seller, uint256 amount);
    error PoolManagerSettlementMismatch(
        address token,
        uint256 paid,
        uint256 expected
    );
    error OwnershipRenounceDisabled();
    error ZeroAddress();
    error NotAuthorizedKeeper();
    error UnexpectedHookCurrencyDebt(address currency);
    error UnexpectedHookCurrencyCredit(address currency);
    error ManagerDeltaNotZero();
    error SwapRouterAlreadyInitialized();
    error SwapRouterNotConfigured();

    event KeeperUpdated(address indexed oldKeeper, address indexed newKeeper);
    event AllowedSwapSenderUpdated(address indexed account, bool allowed);
    event SwapRouterInitialized(address indexed swapRouter);
    event DarkPoolTradeSettled(
        address indexed buyer,
        address indexed seller,
        address indexed tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut
    );

    constructor(
        IPoolManager _poolManager,
        address initialOwner,
        address initialKeeper,
        address[] memory initialAllowedSwapSenders
    ) BaseHook(_poolManager) EIP712("ShadowMesh", "1") Ownable(initialOwner) {
        if (initialKeeper == address(0)) {
            revert ZeroAddress();
        }
        authorizedKeeper = initialKeeper;

        uint256 len = initialAllowedSwapSenders.length;
        for (uint256 i = 0; i < len; i++) {
            address a = initialAllowedSwapSenders[i];
            if (a == address(0)) {
                revert ZeroAddress();
            }
            allowedSwapSender[a] = true;
            emit AllowedSwapSenderUpdated(a, true);
        }
    }

    /// @notice One-time wire-up after CREATE2 hook deploy + `ShadowMeshSwapRouter` deploy.
    function initializeSwapRouter(address _swapRouter) external onlyOwner {
        if (swapRouter != address(0)) {
            revert SwapRouterAlreadyInitialized();
        }
        if (_swapRouter == address(0)) {
            revert ZeroAddress();
        }
        swapRouter = _swapRouter;
        allowedSwapSender[_swapRouter] = true;
        emit AllowedSwapSenderUpdated(_swapRouter, true);
        emit SwapRouterInitialized(_swapRouter);
    }

    /// @inheritdoc BaseHook
    function getHookPermissions()
        public
        pure
        override
        returns (Hooks.Permissions memory permissions)
    {
        permissions = Hooks.Permissions({
            beforeInitialize: false,
            afterInitialize: false,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: false,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: true,
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    function _beforeSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        bytes calldata hookData
    ) internal override returns (bytes4, BeforeSwapDelta, uint24) {
        if (!allowedSwapSender[sender]) {
            revert SwapSenderNotAllowed(sender);
        }

        (
            DarkPoolIntent memory intent,
            bytes memory buyerSig,
            bytes memory sellerSig
        ) = abi.decode(hookData, (DarkPoolIntent, bytes, bytes));

        if (block.timestamp > intent.deadline) {
            revert IntentExpired(intent.deadline);
        }

        _verifyIntentSignatures(intent, buyerSig, sellerSig);
        _validateIntentForSwap(intent, key, params);

        _useCheckedNonce(intent.buyer, intent.buyerNonce);
        _useCheckedNonce(intent.seller, intent.sellerNonce);

        BeforeSwapDelta noOpDelta = _settleExactInputOTC(intent);

        emit DarkPoolTradeSettled(
            intent.buyer,
            intent.seller,
            intent.tokenIn,
            intent.tokenOut,
            intent.amountIn,
            intent.amountOut
        );

        return (BaseHook.beforeSwap.selector, noOpDelta, 0);
    }

    /// @notice Entry for KeeperHub (`authorizedKeeper`) to run the dark-pool swap inside a PoolManager lock.
    function executeDarkPoolSwap(
        PoolKey calldata key,
        SwapParams calldata params,
        bytes calldata hookData
    ) external {
        if (msg.sender != authorizedKeeper) {
            revert NotAuthorizedKeeper();
        }
        poolManager.unlock(abi.encode(key, params, hookData));
    }

    /// @inheritdoc IUnlockCallback
    function unlockCallback(bytes calldata data)
        external
        override
        onlyPoolManager
        returns (bytes memory)
    {
        if (swapRouter == address(0)) {
            revert SwapRouterNotConfigured();
        }

        (PoolKey memory key, SwapParams memory params, bytes memory hookData) =
            abi.decode(data, (PoolKey, SwapParams, bytes));

        ShadowMeshSwapRouter(swapRouter).swap(key, params, hookData);

        (DarkPoolIntent memory intent,,) = abi.decode(hookData, (DarkPoolIntent, bytes, bytes));

        // Clear the hook's own open deltas (tokenOut credit → take to buyer; tokenIn debt → impossible here).
        _clearHookDeltaOnCurrency(key.currency0, intent);
        _clearHookDeltaOnCurrency(key.currency1, intent);

        // Clear the router's tokenIn debt: BeforeSwapDelta(+amountIn specified, 0) causes PoolManager to
        // assign -amountIn on the router (swap caller). Pull tokenIn from buyer and credit the router.
        Currency tokenIn = Currency.wrap(intent.tokenIn);
        int256 routerDebt = poolManager.currencyDelta(swapRouter, tokenIn);
        if (routerDebt < 0) {
            poolManager.sync(tokenIn);
            _transferFrom(tokenIn, intent.buyer, address(poolManager), uint256(-routerDebt));
            poolManager.settleFor(swapRouter);
        }

        if (poolManager.getNonzeroDeltaCount() != 0) {
            revert ManagerDeltaNotZero();
        }
        return "";
    }

    function setAuthorizedKeeper(address newKeeper) external onlyOwner {
        if (newKeeper == address(0)) {
            revert ZeroAddress();
        }
        address oldKeeper = authorizedKeeper;
        authorizedKeeper = newKeeper;
        emit KeeperUpdated(oldKeeper, newKeeper);
    }

    function setAllowedSwapSender(
        address account,
        bool allowed
    ) external onlyOwner {
        if (account == address(0)) {
            revert ZeroAddress();
        }
        allowedSwapSender[account] = allowed;
        emit AllowedSwapSenderUpdated(account, allowed);
    }

    function renounceOwnership() public view override onlyOwner {
        revert OwnershipRenounceDisabled();
    }

    function _verifyIntentSignatures(
        DarkPoolIntent memory intent,
        bytes memory buyerSig,
        bytes memory sellerSig
    ) internal view {
        bytes32 structHash = keccak256(
            abi.encode(
                INTENT_TYPEHASH,
                intent.tokenIn,
                intent.tokenOut,
                intent.fee,
                intent.tickSpacing,
                intent.amountIn,
                intent.amountOut,
                intent.buyer,
                intent.seller,
                intent.buyerNonce,
                intent.sellerNonce,
                intent.deadline
            )
        );
        bytes32 digest = _hashTypedDataV4(structHash);

        if (
            !SignatureChecker.isValidSignatureNow(
                intent.buyer,
                digest,
                buyerSig
            ) ||
            !SignatureChecker.isValidSignatureNow(
                intent.seller,
                digest,
                sellerSig
            )
        ) {
            revert InvalidAISignature();
        }
    }

    function _validateIntentForSwap(
        DarkPoolIntent memory intent,
        PoolKey calldata key,
        SwapParams calldata params
    ) internal view {
        if (
            intent.tokenIn == address(0) ||
            intent.tokenOut == address(0) ||
            intent.buyer == address(0) ||
            intent.seller == address(0) ||
            intent.tokenIn == intent.tokenOut ||
            intent.buyer == intent.seller ||
            intent.amountIn == 0 ||
            intent.amountOut == 0
        ) {
            revert InvalidIntent();
        }

        if (
            address(key.hooks) != address(this) ||
            key.fee != intent.fee ||
            key.tickSpacing != intent.tickSpacing
        ) {
            revert InvalidSwap();
        }

        address currency0 = Currency.unwrap(key.currency0);
        address currency1 = Currency.unwrap(key.currency1);
        bool matchesDirection = params.zeroForOne
            ? intent.tokenIn == currency0 && intent.tokenOut == currency1
            : intent.tokenIn == currency1 && intent.tokenOut == currency0;

        if (!matchesDirection) {
            revert InvalidSwap();
        }

        if (
            params.amountSpecified >= 0 ||
            params.amountSpecified == type(int256).min
        ) {
            revert ExactOutputUnsupported();
        }

        uint256 specifiedAmount = uint256(-params.amountSpecified);
        if (specifiedAmount != intent.amountIn) {
            revert InvalidSwap();
        }
    }

    function _settleExactInputOTC(
        DarkPoolIntent memory intent
    ) internal returns (BeforeSwapDelta) {
        Currency tokenIn = Currency.wrap(intent.tokenIn);
        Currency tokenOut = Currency.wrap(intent.tokenOut);

        poolManager.sync(tokenOut);
        _transferFrom(
            tokenOut,
            intent.seller,
            address(poolManager),
            intent.amountOut
        );
        uint256 paid = poolManager.settle();

        if (paid != intent.amountOut) {
            revert PoolManagerSettlementMismatch(
                intent.tokenOut,
                paid,
                intent.amountOut
            );
        }

        poolManager.mint(intent.seller, tokenIn.toId(), intent.amountIn);

        // deltaSpecified zeros the pool leg (exact-in: amountSpecified is negative, hookDeltaSpecified cancels it).
        // deltaUnspecified is 0: tokenOut was already settled directly above via sync/transferFrom/settle,
        // giving the hook +amountOut WETH credit. Adding it again via BeforeSwapDelta would double-credit
        // and cause PoolManager to try to take 2× amountOut when only amountOut was deposited.
        int128 deltaSpecified = _toInt128(intent.amountIn);
        int128 deltaUnspecified = 0;

        return toBeforeSwapDelta(deltaSpecified, deltaUnspecified);
    }

    function _clearHookDeltaOnCurrency(Currency currency, DarkPoolIntent memory intent) private {
        int256 d = poolManager.currencyDelta(address(this), currency);
        if (d == 0) {
            return;
        }
        address token = Currency.unwrap(currency);
        if (d < 0) {
            if (token != intent.tokenIn) {
                revert UnexpectedHookCurrencyDebt(token);
            }
            uint256 owe = uint256(-d);
            poolManager.sync(currency);
            _transferFrom(currency, intent.buyer, address(poolManager), owe);
            poolManager.settle();
        } else {
            if (token != intent.tokenOut) {
                revert UnexpectedHookCurrencyCredit(token);
            }
            poolManager.take(currency, intent.buyer, uint256(d));
        }
    }

    function _transferFrom(
        Currency currency,
        address from,
        address to,
        uint256 amount
    ) internal {
        address token = Currency.unwrap(currency);
        bool success = IERC20Minimal(token).transferFrom(from, to, amount);

        if (!success) {
            revert SellerTransferFailed(token, from, amount);
        }
    }

    function _toInt128(uint256 amount) internal pure returns (int128) {
        if (amount > uint256(uint128(type(int128).max))) {
            revert AmountTooLarge(amount);
        }
        return int128(uint128(amount));
    }
}
