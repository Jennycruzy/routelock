// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {Roles} from "./RouteLockTypes.sol";

/// @title SettlementEscrow
/// @notice Holds buyer payments and issuer collateral. The only contract in the
///         system that moves value.
///
/// The central rule of RouteLock lives here: **money moves on carrier
/// confirmation, never on AI approval.** The compliance engine can open the
/// activation gate, but funds only become claimable when the backend oracle
/// records a real label from a real carrier response.
///
/// That separation is enforced structurally rather than by convention.
/// `COMPLIANCE_ROLE` is not merely ungranted here — `_grantRole` *rejects* it,
/// so no admin, present or future, can grant the compliance service authority
/// over funds even by mistake.
contract SettlementEscrow is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @dev Raised if anyone tries to give the compliance service power over money.
    error ComplianceRoleForbiddenHere();

    error ClassAlreadyRegistered(bytes32 classId);
    error UnknownClass(bytes32 classId);
    error UnknownDeposit(uint256 tokenId);
    error AlreadySettled(uint256 tokenId);
    error InsufficientCollateral(bytes32 classId, uint256 have, uint256 need);
    error NothingToClaim();
    error ZeroAddress();
    error ZeroAmount();

    event ClassRegistered(bytes32 indexed classId, address indexed issuer, address token, uint256 payoutObligation);
    event CollateralPosted(bytes32 indexed classId, address indexed from, uint256 amount);
    event CollateralWithdrawn(bytes32 indexed classId, address indexed to, uint256 amount);
    event DepositRecorded(uint256 indexed tokenId, bytes32 indexed classId, address indexed buyer, uint256 amount);
    event SettlementReleased(uint256 indexed tokenId, address indexed issuer, uint256 amount);
    event BuyerRefunded(uint256 indexed tokenId, address indexed buyer, uint256 amount);
    event Claimed(address indexed issuer, address indexed token, uint256 amount);

    struct ClassEscrow {
        address issuer;
        address token;
        uint256 payoutObligation; // owed per outstanding unit
        uint256 collateral; // posted by the issuer
        uint256 obligation; // payoutObligation * outstanding units
        bool registered;
    }

    struct Deposit {
        bytes32 classId;
        address buyer;
        uint256 amount;
        bool settled;
    }

    mapping(bytes32 classId => ClassEscrow) public classEscrow;
    mapping(uint256 tokenId => Deposit) public deposits;
    mapping(address issuer => mapping(address token => uint256)) public claimable;

    constructor(address admin) {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(Roles.ADMIN_ROLE, admin);
    }

    // ---------------------------------------------------------------------
    // Class registration and collateral — spec §4.2 backing invariant
    // ---------------------------------------------------------------------

    function registerClass(bytes32 classId, address issuer, address token, uint256 payoutObligation)
        external
        onlyRole(Roles.FACTORY_ROLE)
    {
        ClassEscrow storage esc = classEscrow[classId];
        if (esc.registered) revert ClassAlreadyRegistered(classId);
        if (issuer == address(0) || token == address(0)) revert ZeroAddress();

        esc.issuer = issuer;
        esc.token = token;
        esc.payoutObligation = payoutObligation;
        esc.registered = true;

        emit ClassRegistered(classId, issuer, token, payoutObligation);
    }

    /// @notice Post collateral backing a class. Anyone may fund an issuer's
    ///         class — the money is committed to the class either way.
    function postCollateral(bytes32 classId, uint256 amount) external nonReentrant {
        ClassEscrow storage esc = classEscrow[classId];
        if (!esc.registered) revert UnknownClass(classId);
        if (amount == 0) revert ZeroAmount();

        esc.collateral += amount;
        IERC20(esc.token).safeTransferFrom(msg.sender, address(this), amount);

        emit CollateralPosted(classId, msg.sender, amount);
    }

    /// @notice Withdraw collateral down to — never below — outstanding obligations.
    function withdrawCollateral(bytes32 classId, uint256 amount) external nonReentrant {
        ClassEscrow storage esc = classEscrow[classId];
        if (!esc.registered) revert UnknownClass(classId);
        if (msg.sender != esc.issuer) revert AccessControlUnauthorizedAccount(msg.sender, Roles.ISSUER_ROLE);
        if (amount == 0) revert ZeroAmount();

        uint256 remaining = esc.collateral - amount; // reverts on underflow
        if (remaining < esc.obligation) {
            revert InsufficientCollateral(classId, remaining, esc.obligation);
        }

        esc.collateral = remaining;
        IERC20(esc.token).safeTransfer(esc.issuer, amount);

        emit CollateralWithdrawn(classId, esc.issuer, amount);
    }

    // ---------------------------------------------------------------------
    // Buyer deposits
    // ---------------------------------------------------------------------

    /// @notice Pull a buyer's payment and register the issuer's new obligation.
    ///
    /// Funds move from the buyer straight into this contract — they never pass
    /// through the factory, so there is no intermediate balance to misdirect.
    /// Reverts unless collateral covers the obligation *after* this mint, which
    /// is the on-chain form of "no uncollateralized issuance is reachable".
    function recordMint(uint256 tokenId, bytes32 classId, address buyer, uint256 price)
        external
        onlyRole(Roles.FACTORY_ROLE)
        nonReentrant
    {
        ClassEscrow storage esc = classEscrow[classId];
        if (!esc.registered) revert UnknownClass(classId);

        uint256 newObligation = esc.obligation + esc.payoutObligation;
        if (esc.collateral < newObligation) {
            revert InsufficientCollateral(classId, esc.collateral, newObligation);
        }
        esc.obligation = newObligation;

        deposits[tokenId] = Deposit({classId: classId, buyer: buyer, amount: price, settled: false});

        if (price > 0) {
            IERC20(esc.token).safeTransferFrom(buyer, address(this), price);
        }

        emit DepositRecorded(tokenId, classId, buyer, price);
    }

    // ---------------------------------------------------------------------
    // Settlement — oracle only, on real carrier confirmation
    // ---------------------------------------------------------------------

    /// @notice The carrier produced a label. The issuer becomes payable.
    /// @dev Callable only by `ORACLE_ROLE`. The compliance service cannot reach
    ///      this function, and cannot be granted a role that would let it.
    function releaseToIssuer(uint256 tokenId) external onlyRole(Roles.ORACLE_ROLE) {
        Deposit storage dep = _liveDeposit(tokenId);
        ClassEscrow storage esc = classEscrow[dep.classId];

        dep.settled = true;
        _dischargeObligation(esc);
        claimable[esc.issuer][esc.token] += dep.amount;

        emit SettlementReleased(tokenId, esc.issuer, dep.amount);
    }

    /// @notice Return a buyer's funds — refusal, remedy, or expiry.
    function refundBuyer(uint256 tokenId) external onlyRole(Roles.ORACLE_ROLE) nonReentrant {
        Deposit storage dep = _liveDeposit(tokenId);
        ClassEscrow storage esc = classEscrow[dep.classId];

        dep.settled = true;
        _dischargeObligation(esc);

        uint256 amount = dep.amount;
        address buyer = dep.buyer;
        if (amount > 0) {
            IERC20(esc.token).safeTransfer(buyer, amount);
        }

        emit BuyerRefunded(tokenId, buyer, amount);
    }

    /// @notice Issuer withdraws everything released to them in a given token.
    function claim(address token) external nonReentrant {
        uint256 amount = claimable[msg.sender][token];
        if (amount == 0) revert NothingToClaim();

        claimable[msg.sender][token] = 0;
        IERC20(token).safeTransfer(msg.sender, amount);

        emit Claimed(msg.sender, token, amount);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice The backing invariant, exposed so it can be asserted from tests
    ///         and monitored from outside.
    function isFullyBacked(bytes32 classId) external view returns (bool) {
        ClassEscrow storage esc = classEscrow[classId];
        return esc.collateral >= esc.obligation;
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    function _liveDeposit(uint256 tokenId) private view returns (Deposit storage dep) {
        dep = deposits[tokenId];
        if (dep.buyer == address(0)) revert UnknownDeposit(tokenId);
        if (dep.settled) revert AlreadySettled(tokenId);
    }

    function _dischargeObligation(ClassEscrow storage esc) private {
        uint256 owed = esc.payoutObligation;
        esc.obligation = esc.obligation > owed ? esc.obligation - owed : 0;
    }

    /// @dev The structural half of "the AI never touches money".
    ///
    /// Overriding the grant path rather than simply not granting the role means
    /// the guarantee survives future admins and future upgrades to the wiring
    /// script. There is no sequence of calls, by any account, that gives
    /// `COMPLIANCE_ROLE` authority in this contract.
    function _grantRole(bytes32 role, address account) internal override returns (bool) {
        if (role == Roles.COMPLIANCE_ROLE) revert ComplianceRoleForbiddenHere();
        return super._grantRole(role, account);
    }
}
