import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

export default buildModule("ShadowMeshModule", (m) => {
  const mockWETH = m.contract("MockERC20", ["Mock Wrapped Ether", "mWETH"], {
    id: "MockWETH",
  });

  const mockUSDC = m.contract("MockERC20", ["Mock USD Coin", "mUSDC"], {
    id: "MockUSDC",
  });

  const shadowMeshHookAddress = m.getParameter(
    "shadowMeshHook",
    "0x0000000000000000000000000000000000000000",
  );

  const shadowMeshHook = m.contractAt("ShadowMeshHook", shadowMeshHookAddress);

  return { mockWETH, mockUSDC, shadowMeshHook };
});