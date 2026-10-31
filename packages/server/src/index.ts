export const name = '@keeta-checkout/server';
export const version = '0.0.0';

export {
  AmountError,
  MAX_DECIMALS,
  assertDecimals,
  formatBaseUnits,
  parseDecimalAmount,
  type AmountErrorCode,
  type FormatOptions
} from './amounts.ts';

export {
  TokenError,
  TokenRegistry,
  normalizeTicker,
  type ResolvedToken,
  type TokenErrorCode,
  type TokenRegistryOptions
} from './tokens.ts';

export {
  EXPLORER_URL,
  configFromEnv,
  resolveConfig,
  type CheckoutConfig,
  type CheckoutConfigInput,
  type KeetaNetworkName,
  type WebhookEndpoint
} from './config.ts';

export { CheckoutError, type ErrorType, type SerialisedError } from './errors.ts';

export {
  PaymentRequestError,
  buildPaymentUri,
  parsePaymentUri,
  qrPath,
  qrSvgUrlFor,
  renderQrSvg,
  type PaymentRequestErrorCode,
  type QrOptions
} from './payment-request.ts';

export {
  TERMINAL_STATUSES,
  isTerminal,
  type CreateSessionInput,
  type MerchantSessionView,
  type PublicSessionView,
  type Session,
  type SessionStatus
} from './sessions/types.ts';

export {
  EXTERNAL_MAX_LENGTH,
  generatePaymentReference,
  generateSessionId,
  isValidExternal
} from './sessions/refs.ts';

export {
  MemorySessionStore,
  REFUNDABLE_DISPOSITIONS,
  StoreError,
  applyMarkPaid,
  applyMarkUnmatched,
  cloneSession,
  paymentKey,
  type DeliveryResultUpdate,
  type ObservedPayment,
  type PaymentDisposition,
  type PaymentRecord,
  type PaymentRow,
  type PaymentsQuery,
  type SessionStore,
  type StoreErrorCode
} from './sessions/store.ts';

export { classifyPayment, type Classification, type PaymentAction } from './watcher/matcher.ts';
export {
  SEND_OPERATION_TYPE,
  extractInboundSends,
  type BlockLike,
  type HistoryEntryLike,
  type HistoryQuery,
  type HistorySource,
  type OperationLike,
  type StapleLike
} from './watcher/history-source.ts';
export { CURSOR_META_KEY, PaymentWatcher, type PaymentWatcherOptions, type ScanResult } from './watcher/watcher.ts';

export { SqliteSessionStore, type SqliteSessionStoreOptions } from './sessions/sqlite-store.ts';

export {
  CheckoutService,
  type CheckoutServiceOptions,
  type ProcessedPayment,
  type SessionChangeEvent
} from './sessions/service.ts';

export {
  DEFAULT_TOLERANCE_SECONDS,
  SIGNATURE_HEADER,
  SIGNATURE_SCHEME,
  WebhookSignatureError,
  signWebhook,
  signedPayload,
  verifyWebhookSignature,
  type SignatureFailureReason,
  type VerifyOptions
} from './webhooks/signature.ts';

export {
  EVENT_TYPE_BY_STATUS,
  WEBHOOK_EVENT_TYPES,
  type DeliveriesQuery,
  type DeliveryAttemptResult,
  type DeliveryStatus,
  type WebhookDelivery,
  type WebhookEvent,
  type WebhookEventType,
  type WebhookPaymentView
} from './webhooks/types.ts';

export {
  MAX_ATTEMPTS,
  REQUEST_TIMEOUT_MS,
  RETRY_SCHEDULE_MS,
  WebhookDispatcher,
  type WebhookDispatcherOptions
} from './webhooks/dispatcher.ts';

export { requireApiKey, type ApiKeyAuthOptions } from './http/auth.ts';
export { createApp, type CheckoutApp, type CreateAppOptions } from './http/app.ts';
export {
  escapeHtml,
  jsonForScript,
  newNonce,
  payPageCsp,
  renderPayPage,
  type PayPageOptions
} from './http/pay-page.ts';
