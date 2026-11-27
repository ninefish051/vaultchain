// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {CardPriceOracle} from "../src/CardPriceOracle.sol";
import {VaultCardNFT} from "../src/VaultCardNFT.sol";
import {VaultEscrow} from "../src/VaultEscrow.sol";
import {VaultMarket} from "../src/VaultMarket.sol";
import {SwapEscrow} from "../src/SwapEscrow.sol";
import {VaultSwap} from "../src/VaultSwap.sol";

abstract contract Base is Test {
    MockUSDC usdc;
    CardPriceOracle oracle;
    VaultCardNFT nft;
    VaultEscrow escrow;
    VaultMarket market;
    SwapEscrow swapEscrow;
    VaultSwap vswap;

    address admin = makeAddr("admin");
    address treasury = makeAddr("treasury");
    address vault = makeAddr("vault");
    address arbiter = makeAddr("arbiter");
    address relayer = makeAddr("relayer");
    uint256 signerPk = 0xA11CE;
    uint256 buyerPk = 0xB0B;
    uint256 sellerPk = 0x5E11;
    address oracleSigner;
    address buyer;
    address seller;

    bytes32 constant CARD = keccak256("pokemon|base1|4/102|EN|holo|PSA|10");
    bytes32 constant SLAB = keccak256("PSA|12345678");
    bytes32 constant META = keccak256("meta");
    uint128 constant PRICE = 5_000e6; // $5,000
    bytes32 constant CARD2 = keccak256("pokemon|base1|58/102|EN|1st|PSA|10");
    bytes32 constant SLAB2 = keccak256("PSA|87654321");
    bytes32 constant META2 = keccak256("meta2");

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        oracleSigner = vm.addr(signerPk);
        buyer = vm.addr(buyerPk);
        seller = vm.addr(sellerPk);

        usdc = new MockUSDC();
        oracle = new CardPriceOracle(admin);
        nft = new VaultCardNFT(admin, "https://api.vaultchain.xyz/nft/");
        escrow = new VaultEscrow(
            admin,
            IERC20(address(usdc)),
            oracle,
            nft,
            treasury,
            VaultEscrow.Config({
                minDepositBps: 1000,
                maxDepositBps: 3000,
                volMultiplierBps: 20_000,
                minPenaltyBps: 500,
                feeBps: 100,
                maxPriceDeviationBps: 5000,
                maxPriceAge: 2 days
            })
        );
        market = new VaultMarket(admin, IERC20(address(usdc)), nft, treasury, 100);
        swapEscrow = new SwapEscrow(
            admin,
            IERC20(address(usdc)),
            oracle,
            nft,
            treasury,
            SwapEscrow.Config({
                minDepositBps: 1000,
                maxDepositBps: 3000,
                volMultiplierBps: 20_000,
                minPenaltyBps: 500,
                feeBps: 100,
                maxValueDeviationBps: 1000,
                maxPriceAge: 2 days
            })
        );
        vswap = new VaultSwap(admin, IERC20(address(usdc)), nft, treasury, 5e6);

        vm.startPrank(admin);
        oracle.grantRole(oracle.ORACLE_SIGNER_ROLE(), oracleSigner);
        nft.grantRole(nft.MINTER_ROLE(), address(escrow));
        nft.grantRole(nft.MINTER_ROLE(), vault);
        nft.grantRole(nft.VAULT_ROLE(), vault);
        escrow.grantRole(escrow.VAULT_ROLE(), vault);
        escrow.grantRole(escrow.ARBITER_ROLE(), arbiter);
        escrow.grantRole(escrow.RELAYER_ROLE(), relayer);
        escrow.grantRole(escrow.TREASURY_ROLE(), treasury);
        nft.grantRole(nft.MINTER_ROLE(), address(swapEscrow));
        swapEscrow.grantRole(swapEscrow.VAULT_ROLE(), vault);
        swapEscrow.grantRole(swapEscrow.ARBITER_ROLE(), arbiter);
        swapEscrow.grantRole(swapEscrow.RELAYER_ROLE(), relayer);
        vm.stopPrank();

        usdc.mint(buyer, 100_000e6);
        usdc.mint(seller, 100_000e6);
        usdc.mint(treasury, 100_000e6);
        vm.prank(buyer);
        usdc.approve(address(escrow), type(uint256).max);
        vm.prank(seller);
        usdc.approve(address(escrow), type(uint256).max);
        vm.prank(treasury);
        usdc.approve(address(escrow), type(uint256).max);
        address[2] memory parties = [buyer, seller];
        for (uint256 i = 0; i < 2; i++) {
            vm.startPrank(parties[i]);
            usdc.approve(address(swapEscrow), type(uint256).max);
            usdc.approve(address(vswap), type(uint256).max);
            nft.setApprovalForAll(address(swapEscrow), true);
            nft.setApprovalForAll(address(vswap), true);
            vm.stopPrank();
        }

        _setPrice(CARD, 5_000e6, 800); // fair value $5,000, 8% volatility
        _setPrice(CARD2, 6_000e6, 600); // fair value $6,000, 6% volatility
    }

    // ------------------------------------------------------------------ helpers

    function _pricePoint(uint128 fair, uint32 vol) internal view returns (CardPriceOracle.PricePoint memory) {
        return CardPriceOracle.PricePoint({
            fairValueUsd: fair,
            volatilityBps: vol,
            sampleCount: 12,
            confidence: 90,
            updatedAt: uint64(vm.getBlockTimestamp()),
            evidenceHash: keccak256(abi.encode(fair, vm.getBlockTimestamp()))
        });
    }

    function _signPrice(uint256 pk, bytes32 cardKey, CardPriceOracle.PricePoint memory p)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, oracle.hashPricePoint(cardKey, p));
        return abi.encodePacked(r, s, v);
    }

    function _setPrice(bytes32 cardKey, uint128 fair, uint32 vol) internal {
        CardPriceOracle.PricePoint memory p = _pricePoint(fair, vol);
        oracle.submitPrice(cardKey, p, _signPrice(signerPk, cardKey, p));
    }

    function _forcePrice(bytes32 cardKey, uint128 fair, uint32 vol) internal {
        vm.prank(admin);
        oracle.forceSetPrice(cardKey, _pricePoint(fair, vol));
    }

    function _terms(uint8 fulfillment, uint256 nonce) internal view returns (VaultEscrow.OrderTerms memory) {
        return VaultEscrow.OrderTerms({
            buyer: buyer,
            seller: seller,
            cardKey: CARD,
            slabId: SLAB,
            metadataHash: META,
            priceUsd: PRICE,
            depositWindow: 1 days,
            shipWindow: 3 days,
            inspectWindow: 2 days,
            payWindow: 2 days,
            fulfillment: fulfillment,
            nonce: nonce,
            signDeadline: uint64(vm.getBlockTimestamp() + 1 hours)
        });
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _create(VaultEscrow.OrderTerms memory t) internal returns (bytes32 id) {
        bytes32 digest = escrow.hashOrderTerms(t);
        id = escrow.createOrder(t, _sign(buyerPk, digest), _sign(sellerPk, digest));
    }

    function _createAndLock(uint8 fulfillment) internal returns (bytes32 id) {
        id = _create(_terms(fulfillment, 1));
        vm.prank(buyer);
        escrow.fund(id);
        vm.prank(seller);
        escrow.fund(id);
    }

    function _toPaymentWindow(uint8 fulfillment) internal returns (bytes32 id) {
        id = _createAndLock(fulfillment);
        vm.prank(seller);
        escrow.markShipped(id, keccak256("SF123"));
        vm.prank(vault);
        escrow.submitInspection(id, true, keccak256("report"));
    }

    function _status(bytes32 id) internal view returns (VaultEscrow.Status) {
        return escrow.getOrder(id).status;
    }

    /// @dev Core accounting invariant: escrow balance always covers what it owes.
    function _assertSolvent() internal view {
        assertEq(usdc.balanceOf(address(escrow)), escrow.totalHeld() + escrow.unallocatedBalance());
        assertGe(usdc.balanceOf(address(escrow)), escrow.totalHeld());
    }
}
