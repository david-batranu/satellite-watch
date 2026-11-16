/** Data sources, accuracy notes and privacy. */

import { useAppStore } from '../state/store';
import { Sheet } from './Sheet';

export function CreditsSheet() {
  const sheet = useAppStore((state) => state.sheet);
  const closeSheet = useAppStore((state) => state.closeSheet);

  return (
    <Sheet open={sheet === 'credits'} title="Data & privacy" onClose={closeSheet}>
      <div className="credits">
        <p>
          Satellite Watch runs entirely on your device. Your location, camera feed and motion
          readings never leave the phone — there is no account, no analytics and no tracking.
        </p>
        <ul className="credits__list">
          <li className="credits__item">
            <strong>Satellite elements — CelesTrak</strong>
            Two-line elements fetched from celestrak.org (Dr T.S. Kelso). Orbital positions are
            propagated with SGP4. Accuracy degrades away from the element epoch; the app refreshes
            automatically and shows the age of the data.
          </li>
          <li className="credits__item">
            <strong>Stars &amp; constellations — d3-celestial</strong>
            Hipparcos star catalogue and IAU constellation figures via Olaf Frohn&apos;s
            d3-celestial project. Magnitudes to 6.
          </li>
          <li className="credits__item">
            <strong>Sun, Moon &amp; planets — astronomy-engine</strong>
            Positions computed with Don Cross&apos;s astronomy-engine, including topocentric
            parallax and atmospheric refraction.
          </li>
          <li className="credits__item">
            <strong>Sensor fusion</strong>
            Device orientation follows the W3C DeviceOrientation conventions, blended with raw
            gyroscope and accelerometer data through a complementary filter. Compass error varies
            by phone — use the calibration sheet when precision matters.
          </li>
        </ul>
        <p style={{ marginTop: 16 }}>
          Star visual positions include precession to the current epoch and atmospheric refraction,
          so they match what your eye sees near the horizon. Satellite positions do not include
          refraction (the effect is below the prediction uncertainty at low elevation).
        </p>
        <p>Version 1.0.0</p>
      </div>
    </Sheet>
  );
}
