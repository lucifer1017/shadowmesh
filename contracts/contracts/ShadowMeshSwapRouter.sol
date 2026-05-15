// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPoolManager} from "@uniswap/v4-periphery/lib/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-periphery/lib/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-periphery/lib/v4-core/src/types/PoolOperation.sol";

/// @title ShadowMeshSwapRouter
/// @notice Thin external swap caller so PoolManager invokes the hook's `beforeSwap` (avoids v4 self-swap skip).
contract ShadowMeshSwapRouter {
    IPoolManager public immutable poolManager;
    address public immutable hook;

    error OnlyHook();
    error ZeroAddress();

    constructor(IPoolManager _poolManager, address _hook) {
        if (address(_poolManager) == address(0) || _hook == address(0)) {
            revert ZeroAddress();
        }
        poolManager = _poolManager;
        hook = _hook;
    }

    /// @dev Callable only by ShadowMeshHook during `unlockCallback`.
    function swap(PoolKey calldata key, SwapParams calldata params, bytes calldata hookData) external {
        if (msg.sender != hook) revert OnlyHook();
        poolManager.swap(key, params, hookData);
    }
}
