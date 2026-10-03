# Ludo with Friends

Multiplayer Ludo for 2-6 players. Classic cross board for 2-4, pentagon for 5, hexagon for 6.
Create a room, share the 5-letter code, friends join from any device.

Static site (no build step) + Firebase Firestore for live rooms. Deploys to Vercel.

## 1. Firebase setup (5 minutes, free tier is plenty)

1. Go to https://console.firebase.google.com and **Add project**.
2. **Build -> Firestore Database -> Create database** (production mode, any region).
3. In Firestore, open the **Rules** tab, paste the contents of `firestore.rules`, and **Publish**.
4. **Build -> Authentication -> Get started -> Sign-in method -> Anonymous -> Enable**.
5. **Project settings (gear) -> Your apps -> Web (`</>`)**, register an app, and copy the `firebaseConfig` values into `firebase-config.js`.

## 2. Test locally

    npx serve .

Open the printed URL in two browser windows, create a room in one, join with the code in the other.
(Opening `index.html` by double-clicking will not work, because it uses ES modules.)

## 3. Deploy to Vercel

Option A: push this folder to a GitHub repo, then Vercel -> **Add New Project** -> import it.
Framework preset: **Other**. Leave build/output settings empty.

Option B: `npm i -g vercel`, then run `vercel` in this folder.

## 4. Allow your Vercel domain (important)

Firebase console -> **Authentication -> Settings -> Authorized domains -> Add domain**,
and add your Vercel domain (for example `ludo-yourname.vercel.app`). Without this, sign-in fails on the live site.

## Notes

- The `▶ Watch a 5-player demo` button on the home screen works without Firebase.
- Finished rooms stay in Firestore. You can delete old documents in the `rooms` collection from the console whenever you like.
- Keep `firestore.rules` published, otherwise anyone with your config could write to your database.
