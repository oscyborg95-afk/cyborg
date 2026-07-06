// Outbound message templates for the dynamic action bar.
// Edit freely — these are plain functions returning the exact text sent to the customer.

export const templates = {
  askAddress: () =>
    `ස්තූතියි! 🙏 Order එක process කරන්න මේ විස්තර එවන්න:\n\n1. නම\n2. Address එක (district එකත් එක්ක)\n3. Phone number`,

  codConfirm: (totalCod: number) =>
    `ඔබගේ order එක confirm කරන්නම්ද? 📦\n\nගෙදරටම delivery — ලැබෙනකොට ගෙවන්න (COD).\nමුළු මුදල: රු. ${totalCod}\n\nOK කියලා reply කරන්න ✅`,

  shippedConfirmation: (totalCod: number, trackingId: string) =>
    `Daily Cart එකෙන්! 🚚\n\nඔබගේ ඇණවුම සාර්ථකව තහවුරු කළා. Tracking අංකය: ${trackingId}.\nලැබීමට ඇති මුදල: රු. ${totalCod}`,

  trackingAlert: (trackingId: string) =>
    `ඔබේ පැකේජය courier වෙත භාර දුන්නා 📦\nTracking අංකය: ${trackingId}\nදවස් 1–2ක් ඇතුළත ලැබෙයි!`,

  delayBonus: () =>
    `Delivery එක ටිකක් delay වුණා, සමාවෙන්න 🙏\nඒ වෙනුවෙන් ඔබේ ඊළඟ order එකට 10% discount එකක් දෙනවා! 🎁`,
};
