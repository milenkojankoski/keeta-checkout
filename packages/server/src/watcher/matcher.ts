/**
 * The matching rule: given one inbound send and the session its reference names,
 * decide what the send is and what should happen to the session.
 *
 * Pure. No I/O, no clock, no store. Everything it needs is in its arguments, which
 * is what makes it possible to test every branch exhaustively, and that matters
 * because a wrong answer here marks an unpaid order as paid or a paid one as not.
 *
 * Time comparisons use the block's own date, not the wall clock. A watcher catching
 * up after an outage must classify a payment by when it settled, not by when the
 * watcher happened to notice it.
 */
import type { ObservedPayment, PaymentDisposition } from '../sessions/store.ts';
import type { Session } from '../sessions/types.ts';

export type PaymentAction = 'mark-paid' | 'mark-unmatched' | 'none';

export interface Classification {
  disposition: PaymentDisposition;
  action: PaymentAction;
  /** The session the send was attributed to, if any. */
  sessionId: string | null;
  /** Why, in words a merchant can read in a log or a dashboard. */
  reason: string;
}

function same(payment: ObservedPayment, session: Session): boolean {
  return session.blockHash === payment.blockHash && session.operationIndex === payment.operationIndex;
}

/**
 * Classify one inbound send.
 *
 * The order of the checks is the specification:
 *
 * 1. No reference, or a reference no session has: the money cannot be placed.
 * 2. Wrong token or wrong recipient for the session named: not credited.
 * 3. The session is already closed: `cancelled` stays cancelled; a `paid` session
 *    treats the identical send as a replay and any other send as a duplicate; an
 *    `unmatched` session is already dead.
 * 4. The send settled after the grace window: late, and the session is unmatched.
 * 5. Less than the amount owed: underpaid, and the session stays open so the payer
 *    can still pay in full. The merchant refunds the partial.
 * 6. Otherwise it is the payment, overpaid or exact, and the session is paid.
 *
 * Time comes before amount on purpose. A late underpayment is late.
 */
export function classifyPayment(payment: ObservedPayment, session: Session | undefined): Classification {
  if (payment.external === null || payment.external === '') {
    return { disposition: 'no_reference', action: 'none', sessionId: null, reason: 'the send carries no payment reference' };
  }
  if (session === undefined) {
    return {
      disposition: 'unknown_reference',
      action: 'none',
      sessionId: null,
      reason: `no session has the reference ${payment.external}`
    };
  }

  const sessionId = session.id;

  if (payment.tokenAddress !== session.tokenAddress) {
    return {
      disposition: 'wrong_token',
      action: 'none',
      sessionId,
      reason: `session ${sessionId} is priced in ${session.tokenTicker ?? session.tokenAddress}, not ${payment.tokenAddress}`
    };
  }
  if (payment.to !== session.receivingAddress) {
    return {
      disposition: 'wrong_recipient',
      action: 'none',
      sessionId,
      reason: `session ${sessionId} expects payment to ${session.receivingAddress}, not ${payment.to}`
    };
  }

  switch (session.status) {
    case 'cancelled':
      return { disposition: 'cancelled', action: 'none', sessionId, reason: `session ${sessionId} was cancelled before this send settled` };
    case 'paid':
      if (same(payment, session)) {
        return {
          disposition: session.overpaidBy === null ? 'matched' : 'overpaid',
          action: 'none',
          sessionId,
          reason: `session ${sessionId} is already paid by this exact send`
        };
      }
      return {
        disposition: 'duplicate',
        action: 'mark-unmatched',
        sessionId,
        reason: `session ${sessionId} was already paid by block ${session.blockHash ?? '?'} operation ${session.operationIndex ?? '?'}`
      };
    case 'unmatched':
      return { disposition: 'duplicate', action: 'none', sessionId, reason: `session ${sessionId} already holds an unmatched payment` };
    case 'open':
    case 'expired':
      break;
  }

  if (payment.blockDate > session.graceUntil) {
    return {
      disposition: 'late',
      action: 'mark-unmatched',
      sessionId,
      reason: `settled at ${new Date(payment.blockDate).toISOString()}, after the grace window closed at ${new Date(session.graceUntil).toISOString()}`
    };
  }

  if (payment.amount < session.amount) {
    return {
      disposition: 'underpaid',
      action: 'none',
      sessionId,
      reason: `received ${payment.amount} base units of ${session.amount} owed; the session stays open`
    };
  }

  return {
    disposition: payment.amount > session.amount ? 'overpaid' : 'matched',
    action: 'mark-paid',
    sessionId,
    reason:
      payment.amount > session.amount
        ? `received ${payment.amount} base units, ${payment.amount - session.amount} more than the ${session.amount} owed`
        : `received exactly the ${session.amount} base units owed`
  };
}
