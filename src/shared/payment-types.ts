/** Payment & receiving-account API contract (Worker ↔ UI). Money is integer satang. */

export type PaymentMethod = "BANK_TRANSFER" | "PROMPTPAY" | "CASH" | "OTHER";
export type PaymentRecordStatus = "UNPAID" | "PENDING_VERIFICATION" | "VERIFIED" | "PAID" | "REJECTED" | "REFUNDED";
export type ReceivingAccountStatus = "ACTIVE" | "INACTIVE";

export const PAYMENT_METHODS: readonly PaymentMethod[] = ["BANK_TRANSFER", "PROMPTPAY", "CASH", "OTHER"];

/** Thai bank account: digits with optional dashes. */
export const ACCOUNT_NUMBER_PATTERN = /^[0-9][0-9-]{4,22}[0-9]$/;
/** PromptPay: mobile (10), national/tax ID (13) or e-wallet (15) digits. */
export const PROMPTPAY_PATTERN = /^(\d{10}|\d{13}|\d{15})$/;

export interface ReceivingAccountDto {
  id: string;
  bankName: string;
  accountName: string;
  accountNumber: string | null;
  promptpayNumber: string | null;
  qrAssetId: string | null;
  qrUrl: string | null;
  status: ReceivingAccountStatus;
  isPrimary: boolean;
  sortOrder: number;
  updatedAt: string;
}

export interface ReceivingAccountInput {
  bankName: string;
  accountName: string;
  accountNumber: string | null;
  promptpayNumber: string | null;
  qrAssetId: string | null;
  status: ReceivingAccountStatus;
  sortOrder: number;
}

/** How to pay this booking — from the account snapshot taken when the booking was made. */
export interface PaymentInstructionsDto {
  bankName: string;
  accountName: string;
  accountNumber: string | null;
  promptpayNumber: string | null;
  qrUrl: string | null;
  amountDueSatang: number;
}

export interface PaymentDto {
  id: string;
  amountSatang: number;
  method: PaymentMethod;
  status: PaymentRecordStatus;
  reference: string | null;
  note: string | null;
  paidAt: string | null;
  submittedAt: string;
  verifiedAt: string | null;
  verifiedByName: string | null;
  refundedAt: string | null;
  refundAmountSatang: number | null;
  refundReason: string | null;
  /** Authenticated URL of the private slip (slips.view) when this payment came with a slip. */
  slipUrl: string | null;
}

/** Admin view of the account snapshot (immutable). */
export interface PaymentAccountSnapshotDto {
  receivingAccountId: string;
  bankName: string;
  accountName: string;
  accountNumber: string | null;
  promptpayNumber: string | null;
  qrUrl: string | null;
  capturedAt: string;
}

// ------------------------------------------------------------------ slips (spec §27)

export interface SlipVerificationDto {
  method: "MANUAL" | "AUTO";
  provider: string | null;
  result: "PASSED" | "FAILED" | "ERROR";
  /** AMOUNT_MISMATCH, DATE_OUT_OF_RANGE, RECEIVER_MISMATCH, RECEIVER_UNCONFIRMED, DUPLICATE_TRANSACTION, SLIP_NOT_FOUND, PROVIDER_…, REJECTED_BY_STAFF */
  failureCode: string | null;
  amountSatang: number | null;
  transferredAt: string | null;
  senderBank: string | null;
  receiverBank: string | null;
  receiverAccountMasked: string | null;
  transactionRef: string | null;
  verifiedByName: string | null;
  createdAt: string;
}

export interface SlipQueueItemDto {
  paymentId: string;
  bookingCode: string;
  bookingStatus: string;
  customerName: string;
  checkIn: string;
  checkOut: string;
  totalSatang: number;
  amountSatang: number;
  status: PaymentRecordStatus;
  submittedAt: string;
  /** Authenticated URL of the private slip image (slips.view). */
  slipUrl: string;
  verifications: SlipVerificationDto[];
}

/** Guest result after uploading a slip. */
export interface SlipUploadResultDto {
  /** VERIFIED: the verification service proved the payment — booking confirmed. PENDING_REVIEW: staff will check. */
  outcome: "VERIFIED" | "PENDING_REVIEW";
}
