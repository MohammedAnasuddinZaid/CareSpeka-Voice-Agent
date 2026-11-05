import QRCode from "qrcode";

/** Server-side QR generation. The QR only ever encodes a join URL + token. */
export async function makeQrDataUrl(text: string): Promise<string> {
  return QRCode.toDataURL(text, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 360,
    color: { dark: "#0f172a", light: "#ffffff" },
  });
}
