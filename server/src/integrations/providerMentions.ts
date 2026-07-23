const EMAIL_ADDRESS_RE = /\b[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

/**
 * Provider brands inside recipient addresses are data, not routing instructions.
 * `person@gmail.com` must not compete with an explicit Outlook request, and an
 * `@outlook.com` recipient must not select Microsoft by itself.
 */
export function textForProviderMentionDetection(text: string): string {
  return text.replace(EMAIL_ADDRESS_RE, " ");
}
