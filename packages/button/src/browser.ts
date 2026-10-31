/**
 * The browser bundle's entry point.
 *
 * Built to `dist/keeta-pay-button.js`, a single minified file with no dependencies
 * that registers the element as a side effect:
 *
 * ```html
 * <script src="/keeta-pay-button.js" defer></script>
 * <keeta-pay-button session-id="cs_…" base-url="https://pay.example"></keeta-pay-button>
 * ```
 *
 * Separate from `index.ts` because a module a bundler imports should not define a
 * custom element merely by being imported; a plain `<script src>` should.
 */
import { defineKeetaPayButton, KeetaPayButton } from './pay-button.ts';

defineKeetaPayButton();

// Reachable for anyone who wants to subclass it or register it under another name.
declare global {
  interface Window {
    KeetaPayButton?: typeof KeetaPayButton;
  }
}
if (typeof window !== 'undefined') window.KeetaPayButton = KeetaPayButton;
