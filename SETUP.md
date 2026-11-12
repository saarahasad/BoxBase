# BOXBASE — cloud setup (about 10 minutes, free)

## 1. Create the Firebase project
1. Go to https://console.firebase.google.com → **Add project** → name it `boxbase` (Analytics: off).
2. **Build → Firestore Database → Create database** → pick region **asia-south1 (Mumbai)** → *Start in production mode*.
3. **Firestore → Rules** → paste everything from `firestore.rules` → **Publish**.
4. **Build → Authentication → Get started** → enable **Google** (pick your support email) and **Email/Password**.
5. **Authentication → Settings → Authorized domains → Add domain** → `saarahasad.github.io`

## 2. Connect the app
1. **Project settings (⚙) → Your apps → Web `</>`** → register app `boxbase` (no hosting).
2. Copy the `firebaseConfig` values into `firebase-config.js`.
3. Commit and push. Open `https://saarahasad.github.io/boxbase/` → sign in.

## 3. Move your existing boxes
Open the app **on the phone where you added boxes** → sign in → tap **Move** on the orange banner.
(The old on-phone copy is left untouched as a safety net.)

## 4. Add family
**Account → Family access** → add their email → they open the link and sign in with that email.

## Notes
- Free tier (Spark): 1 GB storage ≈ 4,000–5,000 item photos, 50k reads/day. No card needed.
- Works offline: changes save on the phone and sync when you're back online (watch the dot in the top bar).
- Extra safety: **Account → Download backup** now and then and keep the file in Google Drive.
- After updating `index.html`/`app.js`, bump `VERSION` in `sw.js` so phones pick up the new version.
