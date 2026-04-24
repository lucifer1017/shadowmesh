// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {
    BaseHook,
    Hooks,
    IPoolManager,
    PoolKey,
    SwapParams,
    BeforeSwapDelta
} from "@uniswap/v4-periphery/src/utils/BaseHook.sol";

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";

/// @title ShadowMeshHook
/// @notice Uniswap v4 gatekeeper hook for AI-negotiated dark pool intents.
/// @dev Validates EIP-712 signatures from buyer/seller before allowing swaps.
contract ShadowMeshHook is BaseHook, EIP712, Ownable, Nonces {
    struct DarkPoolIntent {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 amountOut;
        address buyer;
        address seller;
        uint256 deadline;
    }

    address public authorizedKeeper;

    bytes32 private constant INTENT_TYPEHASH =
        keccak256(
            "DarkPoolIntent(address tokenIn,address tokenOut,uint256 amountIn,uint256 amountOut,address buyer,address seller,uint256 deadline)"
        );

    error UnauthorizedKeeper(address caller);
    error InvalidAISignature();
    error IntentExpired(uint256 deadline);

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
        sender;
        key;
        params;

        if (msg.sender != authorizedKeeper) {
            revert UnauthorizedKeeper(msg.sender);
        }

        (DarkPoolIntent memory intent, bytes memory buyerSig, bytes memory sellerSig) = abi.decode(
            hookData,
            (DarkPoolIntent, bytes, bytes)
        );

        if (block.timestamp > intent.deadline) {
            revert IntentExpired(intent.deadline);
        }

        _verifyIntentSignatures(intent, buyerSig, sellerSig);

        _useNonce(intent.buyer);
        _useNonce(intent.seller);

        emit DarkPoolTradeSettled(intent.buyer, intent.seller, intent.amountIn, intent.amountOut);

        return (BaseHook.beforeSwap.selector, BeforeSwapDelta.wrap(0), 0);
    }

    function setAuthorizedKeeper(address newKeeper) external onlyOwner {
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
                intent.amountIn,
                intent.amountOut,
                intent.buyer,
                intent.seller,
                intent.deadline
            )
        );
        bytes32 digest = _hashTypedDataV4(structHash);

        address recoveredBuyer = ECDSA.recover(digest, buyerSig);
        address recoveredSeller = ECDSA.recover(digest, sellerSig);

        if (recoveredBuyer != intent.buyer || recoveredSeller != intent.seller) {
            revert InvalidAISignature();
        }
    }
}
