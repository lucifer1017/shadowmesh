// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {BaseHook} from "@uniswap/v4-periphery/src/utils/BaseHook.sol";
import {Hooks} from "@uniswap/v4-periphery/lib/v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "@uniswap/v4-periphery/lib/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-periphery/lib/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-periphery/lib/v4-core/src/types/PoolOperation.sol";
import {BeforeSwapDelta} from "@uniswap/v4-periphery/lib/v4-core/src/types/BeforeSwapDelta.sol";
import {Currency} from "@uniswap/v4-periphery/lib/v4-core/src/types/Currency.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @title ShadowMeshHook
/// @notice Uniswap v4 gatekeeper hook for AI-negotiated dark pool intents.
/// @dev Validates EIP-712 signatures from buyer/seller before allowing swaps.
contract ShadowMeshHook is BaseHook, EIP712, Ownable, Nonces {
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

    bytes32 private constant INTENT_TYPEHASH =
        keccak256(
            "DarkPoolIntent(address tokenIn,address tokenOut,uint24 fee,int24 tickSpacing,uint256 amountIn,uint256 amountOut,address buyer,address seller,uint256 buyerNonce,uint256 sellerNonce,uint256 deadline)"
        );

    error UnauthorizedKeeper(address caller);
    error InvalidAISignature();
    error IntentExpired(uint256 deadline);
    error InvalidIntent();
    error InvalidSwap();
    error ZeroAddress();

    event KeeperUpdated(address indexed oldKeeper, address indexed newKeeper);
    event DarkPoolTradeSettled(
        address indexed buyer,
        address indexed seller,
        uint256 amountIn,
        uint256 amountOut
    );

    constructor(
        IPoolManager _poolManager,
        address initialOwner,
        address initialKeeper
    ) BaseHook(_poolManager) EIP712("ShadowMesh", "1") Ownable(initialOwner) {
        if (initialKeeper == address(0)) {
            revert ZeroAddress();
        }
        authorizedKeeper = initialKeeper;
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
            beforeSwapReturnDelta: false,
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
        if (sender != authorizedKeeper) {
            revert UnauthorizedKeeper(sender);
        }

        (DarkPoolIntent memory intent, bytes memory buyerSig, bytes memory sellerSig) = abi.decode(
            hookData,
            (DarkPoolIntent, bytes, bytes)
        );

        if (block.timestamp > intent.deadline) {
            revert IntentExpired(intent.deadline);
        }

        _verifyIntentSignatures(intent, buyerSig, sellerSig);

        _validateIntentForSwap(intent, key, params);

        _useCheckedNonce(intent.buyer, intent.buyerNonce);
        _useCheckedNonce(intent.seller, intent.sellerNonce);

        emit DarkPoolTradeSettled(intent.buyer, intent.seller, intent.amountIn, intent.amountOut);

        return (BaseHook.beforeSwap.selector, BeforeSwapDelta.wrap(0), 0);
    }

    function setAuthorizedKeeper(address newKeeper) external onlyOwner {
        if (newKeeper == address(0)) {
            revert ZeroAddress();
        }
        address oldKeeper = authorizedKeeper;
        authorizedKeeper = newKeeper;
        emit KeeperUpdated(oldKeeper, newKeeper);
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
            !SignatureChecker.isValidSignatureNow(intent.buyer, digest, buyerSig)
                || !SignatureChecker.isValidSignatureNow(intent.seller, digest, sellerSig)
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
            intent.tokenIn == address(0) || intent.tokenOut == address(0)
                || intent.buyer == address(0) || intent.seller == address(0)
                || intent.tokenIn == intent.tokenOut || intent.buyer == intent.seller
                || intent.amountIn == 0 || intent.amountOut == 0
        ) {
            revert InvalidIntent();
        }

        if (
            address(key.hooks) != address(this) || key.fee != intent.fee
                || key.tickSpacing != intent.tickSpacing
        ) {
            revert InvalidSwap();
        }

        address currency0 = Currency.unwrap(key.currency0);
        address currency1 = Currency.unwrap(key.currency1);
        bool matchesDirection = params.zeroForOne
            ? intent.tokenIn == currency0 && intent.tokenOut == currency1
            : intent.tokenIn == currency1 && intent.tokenOut == currency0;

        if (!matchesDirection || params.amountSpecified == 0 || params.amountSpecified == type(int256).min) {
            revert InvalidSwap();
        }

        uint256 specifiedAmount = params.amountSpecified < 0
            ? uint256(-params.amountSpecified)
            : uint256(params.amountSpecified);

        if (
            (params.amountSpecified < 0 && specifiedAmount != intent.amountIn)
                || (params.amountSpecified > 0 && specifiedAmount != intent.amountOut)
        ) {
            revert InvalidSwap();
        }
    }
}
