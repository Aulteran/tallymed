// Text that an outside client supplies (an assistant's rationale, a proposed plan name). Control, bidirectional-override and zero-width
// characters are stripped so the text cannot spoof what a reviewer sees. The result is still untrusted and is only ever rendered as plain text.
const HIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/g;
export const cleanText = (v: string) => v.replace(HIDDEN, '').replace(/\r\n?/g, '\n').trim();
