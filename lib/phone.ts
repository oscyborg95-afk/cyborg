// Conversions between WhatsApp JIDs ("94768846320@s.whatsapp.net" from Baileys,
// "94768846320@c.us" from the mock worker) and local Sri Lankan phone format
// ("0768846320"). chatIdToPhone is suffix-agnostic on purpose.

export function chatIdToPhone(chatId: string): string {
  const digits = chatId.split("@")[0].replace(/\D/g, "");
  if (digits.startsWith("94") && digits.length === 11) return `0${digits.slice(2)}`;
  return digits;
}

export function phoneToChatId(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  const intl = digits.startsWith("0") ? `94${digits.slice(1)}` : digits;
  return `${intl}@s.whatsapp.net`;
}
