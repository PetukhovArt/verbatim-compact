export const TAX_RATE = 0.18;

export function price(amount: number): number {
  return Math.round(amount * (1 + TAX_RATE) * 100) / 100;
}
