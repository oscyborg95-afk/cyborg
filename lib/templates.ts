// Outbound message templates for the dynamic action bar.
// Edit freely — these are plain functions returning the exact text sent to the customer.

export const templates = {
  askAddress: () =>
    `ස්තූතියි! 🙏 Order එක process කරන්න මේ විස්තර එවන්න:\n\n1. නම\n2. Address එක (district එකත් එක්ක)\n3. Phone number`,

  codConfirm: (totalCod: number) =>
    `ඔබගේ order එක confirm කරන්නම්ද? 📦\n\nගෙදරටම delivery — ලැබෙනකොට ගෙවන්න (COD).\nමුළු මුදල: රු. ${totalCod}\n\nOK කියලා reply කරන්න ✅`,

  // Sent right after dispatch. Friendly + professional, and clearly flagged as
  // an automated system message. trackingId is optional (omitted before booking).
  shippedConfirmation: (totalCod: number, trackingId?: string) =>
    `🌿 *Daily Cart*\n\n` +
    `ආයුබෝවන්! 🙏 ඔබගේ ඇණවුම සාර්ථකව තහවුරු කර, delivery සඳහා යොමු කර ඇත. ✅\n\n` +
    (trackingId ? `📦 Tracking අංකය: *${trackingId}*\n` : "") +
    `💰 ලැබීමේදී ගෙවීමට ඇති මුදල (COD): *රු. ${totalCod}*\n` +
    `🚚 සාමාන්‍යයෙන් වැඩ කරන දින 1–3ක් ඇතුළත ඔබ වෙත ලැබෙනු ඇත.\n\n` +
    `ඔබගේ ඇණවුමට බොහෝම ස්තූතියි! 💚 ඕනෑම ගැටලුවක් ඇත්නම් මෙම chat එකට reply කරන්න.\n\n` +
    `━━━━━━━━━━━━━━\n` +
    `ⓘ මෙය Daily Cart පද්ධතියෙන් ස්වයංක්‍රීයව (automatically) ජනනය කරන ලද පණිවිඩයකි.`,

  trackingAlert: (trackingId: string) =>
    `ඔබේ පැකේජය courier වෙත භාර දුන්නා 📦\nTracking අංකය: ${trackingId}\nදවස් 1–2ක් ඇතුළත ලැබෙයි!`,

  delayBonus: () =>
    `Delivery එක ටිකක් delay වුණා, සමාවෙන්න 🙏\nඒ වෙනුවෙන් ඔබේ ඊළඟ order එකට 10% discount එකක් දෙනවා! 🎁`,
};
