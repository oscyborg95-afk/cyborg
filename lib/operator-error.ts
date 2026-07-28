export function operatorDataError(area: "customers" | "customer" | "actions" | "payouts"): string {
  const labels = {
    customers: "Customer data",
    customer: "This customer",
    actions: "Action Queue data",
    payouts: "Payout history",
  };
  return `${labels[area]} could not be loaded. Please try again. If this continues, contact support.`;
}
