// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Create2Deployer {
    error DeploymentFailed();

    function deploy(bytes32 salt, bytes calldata creationCode) external returns (address deployed) {
        bytes memory code = creationCode;
        assembly ("memory-safe") {
            deployed := create2(0, add(code, 0x20), mload(code), salt)
        }
        if (deployed == address(0)) {
            revert DeploymentFailed();
        }
    }

    function computeAddress(bytes32 salt, bytes32 creationCodeHash) external view returns (address) {
        bytes32 digest = keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, creationCodeHash));
        return address(uint160(uint256(digest)));
    }
}
