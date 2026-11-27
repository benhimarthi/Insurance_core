import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

/** QR code for authenticator-app (TOTP) enrolment. Generated locally: the secret never leaves the browser. */
export function QrCode({ value }) {
  const [src, setSrc] = useState(null);
  useEffect(() => {
    let live = true;
    QRCode.toDataURL(value, { margin: 1, width: 220 }).then((url) => { if (live) setSrc(url); }, () => {});
    return () => { live = false; };
  }, [value]);
  return src ? <img className="qr" src={src} width="220" height="220" alt="QR code" /> : null;
}
