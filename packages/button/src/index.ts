/**
 * `@keeta-checkout/button`: the drop-in pay button.
 *
 * Plain HTML:
 *
 * ```html
 * <script type="module">
 *   import { defineKeetaPayButton } from '@keeta-checkout/button';
 *   defineKeetaPayButton();
 * </script>
 * <keeta-pay-button session-id="cs_…" base-url="https://pay.example"></keeta-pay-button>
 * ```
 *
 * React: import `KeetaPayButton` from `@keeta-checkout/button/react` instead.
 */
export const name = '@keeta-checkout/button';
export const version = '0.0.0';

export { KeetaPayButton, defineKeetaPayButton, type PayButtonSession } from './pay-button.ts';
