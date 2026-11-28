// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {VaultCardNFT} from "../src/VaultCardNFT.sol";
import {VaultEscrow} from "../src/VaultEscrow.sol";
import {SwapEscrow} from "../src/SwapEscrow.sol";

/// Testnet only: lets a dedicated test vault operator inspect and mint during the end-to-end check,
/// and sends testnet gas to the e2e wallets. Run by the admin (deployer):
///   E2E_BUYER=0x… E2E_SELLER=0x… E2E_VAULT=0x… forge script script/SetupE2E.s.sol \
///     --rpc-url https://testnet.hsk.xyz --account vaultchain-deployer --sender <deployer> --broadcast --slow
contract SetupE2E is Script {
    function run() external {
        require(block.chainid != 177, "SetupE2E: testnet only");
        string memory path = string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json");
        string memory json = vm.readFile(path);
        VaultCardNFT nft = VaultCardNFT(vm.parseJsonAddress(json, ".nft"));
        VaultEscrow escrow = VaultEscrow(vm.parseJsonAddress(json, ".escrow"));
        SwapEscrow swapEscrow = SwapEscrow(vm.parseJsonAddress(json, ".swapEscrow"));

        address buyer = vm.envAddress("E2E_BUYER");
        address seller = vm.envAddress("E2E_SELLER");
        address vault = vm.envAddress("E2E_VAULT");
        uint256 gasEach = vm.envOr("E2E_GAS_WEI", uint256(0.005 ether));

        vm.startBroadcast(msg.sender);
        nft.grantRole(nft.MINTER_ROLE(), vault);
        nft.grantRole(nft.VAULT_ROLE(), vault);
        escrow.grantRole(escrow.VAULT_ROLE(), vault);
        swapEscrow.grantRole(swapEscrow.VAULT_ROLE(), vault);
        payable(buyer).transfer(gasEach);
        payable(seller).transfer(gasEach);
        payable(vault).transfer(gasEach);
        vm.stopBroadcast();

        console.log("granted MINTER/VAULT roles to", vault);
        console.log("sent gas (wei) to each e2e wallet:", gasEach);
    }
}
