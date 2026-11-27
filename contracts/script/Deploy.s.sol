// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CardPriceOracle} from "../src/CardPriceOracle.sol";
import {VaultCardNFT} from "../src/VaultCardNFT.sol";
import {VaultEscrow} from "../src/VaultEscrow.sol";
import {VaultMarket} from "../src/VaultMarket.sol";
import {SwapEscrow} from "../src/SwapEscrow.sol";
import {VaultSwap} from "../src/VaultSwap.sol";
import {MockUSDC} from "../test/mocks/MockUSDC.sol";

/// @notice Deploys the full VaultChain stack and writes addresses to deployments/<chainId>.json.
///
/// Env:
///   PRIVATE_KEY              deployer (becomes admin; hand over to a Safe before mainnet use)
///   USDC_ADDRESS             settlement token; empty = deploy MockUSDC (testnets without USDC)
///   TREASURY_ADDRESS         fee receiver / buyout funder   (default: deployer)
///   ORACLE_SIGNER_ADDRESS    price signer                   (default: deployer)
///   RELAYER_ADDRESS          HSP payment relayer / keeper   (default: deployer)
///   VAULT_OPERATOR_ADDRESS   vault inspection / custody     (default: deployer)
///   NFT_BASE_URI             token metadata base URI
///
/// Example:
///   forge script script/Deploy.s.sol --rpc-url hsk_testnet --broadcast
contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address treasury = vm.envOr("TREASURY_ADDRESS", deployer);
        address oracleSigner = vm.envOr("ORACLE_SIGNER_ADDRESS", deployer);
        address relayer = vm.envOr("RELAYER_ADDRESS", deployer);
        address vaultOperator = vm.envOr("VAULT_OPERATOR_ADDRESS", deployer);
        address usdcAddr = vm.envOr("USDC_ADDRESS", address(0));
        string memory baseURI = vm.envOr("NFT_BASE_URI", string("https://api.vaultchain.xyz/nft/"));

        vm.startBroadcast(pk);

        if (usdcAddr == address(0)) {
            usdcAddr = address(new MockUSDC());
            console.log("MockUSDC deployed (testnet only)");
        }

        CardPriceOracle oracle = new CardPriceOracle(deployer);
        VaultCardNFT nft = new VaultCardNFT(deployer, baseURI);
        VaultEscrow escrow = new VaultEscrow(
            deployer,
            IERC20(usdcAddr),
            oracle,
            nft,
            treasury,
            VaultEscrow.Config({
                minDepositBps: 1000, // 10%
                maxDepositBps: 3000, // 30%
                volMultiplierBps: 20_000, // + 2 x 30d volatility
                minPenaltyBps: 500, // 5% floor compensation
                feeBps: 100, // 1% platform fee
                maxPriceDeviationBps: 5000, // reject orders +-50% from fair value
                maxPriceAge: 2 days
            })
        );
        VaultMarket market = new VaultMarket(deployer, IERC20(usdcAddr), nft, treasury, 100);
        SwapEscrow swapEscrow = new SwapEscrow(
            deployer,
            IERC20(usdcAddr),
            oracle,
            nft,
            treasury,
            SwapEscrow.Config({
                minDepositBps: 1000,
                maxDepositBps: 3000,
                volMultiplierBps: 20_000,
                minPenaltyBps: 500,
                feeBps: 100, // 1% of the card each side receives
                maxValueDeviationBps: 1000, // card + top-up on each side within 10%
                maxPriceAge: 2 days
            })
        );
        VaultSwap vaultSwap = new VaultSwap(deployer, IERC20(usdcAddr), nft, treasury, 5e6); // $5 per side

        oracle.grantRole(oracle.ORACLE_SIGNER_ROLE(), oracleSigner);
        nft.grantRole(nft.MINTER_ROLE(), address(escrow));
        nft.grantRole(nft.MINTER_ROLE(), vaultOperator);
        nft.grantRole(nft.VAULT_ROLE(), vaultOperator);
        escrow.grantRole(escrow.VAULT_ROLE(), vaultOperator);
        escrow.grantRole(escrow.ARBITER_ROLE(), deployer);
        escrow.grantRole(escrow.RELAYER_ROLE(), relayer);
        escrow.grantRole(escrow.TREASURY_ROLE(), treasury);
        nft.grantRole(nft.MINTER_ROLE(), address(swapEscrow));
        nft.grantRole(nft.ESCROW_ROLE(), address(escrow));
        nft.grantRole(nft.ESCROW_ROLE(), address(swapEscrow));
        swapEscrow.grantRole(swapEscrow.VAULT_ROLE(), vaultOperator);
        swapEscrow.grantRole(swapEscrow.ARBITER_ROLE(), deployer);
        swapEscrow.grantRole(swapEscrow.RELAYER_ROLE(), relayer);

        vm.stopBroadcast();

        string memory key = "deployment";
        vm.serializeUint(key, "chainId", block.chainid);
        vm.serializeAddress(key, "usdc", usdcAddr);
        vm.serializeAddress(key, "oracle", address(oracle));
        vm.serializeAddress(key, "nft", address(nft));
        vm.serializeAddress(key, "escrow", address(escrow));
        vm.serializeAddress(key, "market", address(market));
        vm.serializeAddress(key, "swapEscrow", address(swapEscrow));
        vm.serializeAddress(key, "vaultSwap", address(vaultSwap));
        string memory json = vm.serializeUint(key, "deployedAtBlock", block.number);
        string memory path = string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);

        console.log("USDC    ", usdcAddr);
        console.log("Oracle  ", address(oracle));
        console.log("NFT     ", address(nft));
        console.log("Escrow  ", address(escrow));
        console.log("Market  ", address(market));
        console.log("SwapEsc ", address(swapEscrow));
        console.log("VSwap   ", address(vaultSwap));
        console.log("Written to", path);
    }
}
