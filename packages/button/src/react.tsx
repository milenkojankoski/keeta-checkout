/**
 * A React wrapper around `<keeta-pay-button>`.
 *
 * React is a peer dependency and optional: importing this module is what pulls it
 * in, so a plain-HTML shop never pays for it.
 *
 * ```tsx
 * <KeetaPayButton
 *   sessionId={session.id}
 *   baseUrl="https://pay.example"
 *   onPaid={(s) => router.push(s.successUrl)}
 * />
 * ```
 *
 * The wrapper exists because React's DOM handling has two rough edges with custom
 * elements: a custom event name does not map to a React prop, and attributes must
 * be strings. Both are handled here so a React shop writes ordinary React.
 */
import { useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import { defineKeetaPayButton, type KeetaPayButton as KeetaPayButtonElement, type PayButtonSession } from './pay-button.ts';

export interface KeetaPayButtonProps {
  /** The session to pay, from `POST /api/sessions`. */
  sessionId: string;
  /** Where the checkout server is. Omit for same origin. */
  baseUrl?: string;
  /** Button text before the amount. Defaults to "Pay with Keeta". */
  label?: string;
  className?: string;
  style?: CSSProperties;
  onPaid?: (session: PayButtonSession) => void;
  onExpired?: (session: PayButtonSession) => void;
  onCancelled?: (session: PayButtonSession) => void;
  onUnmatched?: (session: PayButtonSession) => void;
  onError?: (error: { message: string }) => void;
}

export function KeetaPayButton(props: KeetaPayButtonProps): React.ReactElement {
  const ref = useRef<KeetaPayButtonElement | null>(null);

  // Registering on mount rather than at import time keeps this safe under
  // server-side rendering, where `customElements` does not exist.
  useEffect(() => {
    defineKeetaPayButton();
  }, []);

  const { onPaid, onExpired, onCancelled, onUnmatched, onError } = props;

  useEffect(() => {
    const node = ref.current;
    if (node === null) return;

    const listeners: Array<[string, EventListener]> = [];
    const bind = <T,>(type: string, handler: ((value: T) => void) | undefined): void => {
      if (handler === undefined) return;
      const listener = ((event: CustomEvent<T>) => handler(event.detail)) as EventListener;
      node.addEventListener(type, listener);
      listeners.push([type, listener]);
    };

    bind<PayButtonSession>('keeta-paid', onPaid);
    bind<PayButtonSession>('keeta-expired', onExpired);
    bind<PayButtonSession>('keeta-cancelled', onCancelled);
    bind<PayButtonSession>('keeta-unmatched', onUnmatched);
    bind<{ message: string }>('keeta-error', onError);

    return () => {
      for (const [type, listener] of listeners) node.removeEventListener(type, listener);
    };
  }, [onPaid, onExpired, onCancelled, onUnmatched, onError]);

  // `session-id` and the rest are attributes, so they are passed as strings. React
  // 19 handles unknown lowercase attributes on a custom element directly.
  return (
    <keeta-pay-button
      ref={ref}
      session-id={props.sessionId}
      {...(props.baseUrl === undefined ? {} : { 'base-url': props.baseUrl })}
      {...(props.label === undefined ? {} : { label: props.label })}
      {...(props.className === undefined ? {} : { class: props.className })}
      {...(props.style === undefined ? {} : { style: props.style })}
    />
  );
}

declare module 'react' {
  // A JSX element declaration has to be a namespace: that is the shape React's
  // own types use, and there is no module-syntax equivalent.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      'keeta-pay-button': {
        ref?: React.Ref<KeetaPayButtonElement>;
        'session-id': string;
        'base-url'?: string;
        label?: string;
        class?: string;
        style?: CSSProperties;
      };
    }
  }
}
