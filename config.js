/* =========================================================================
   THE WALL STORE — CONFIG
   Everything you're likely to need to change lives in this one file.
   ========================================================================= */

// 1) OWNER / ADMIN EMAILS
// Anyone who signs in with one of these emails sees the Admin Dashboard
// instead of the store. Add as many as you like.
// IMPORTANT: this list is also copied into firestore.rules and storage.rules —
// if you change it here, change it in those two files too, or the security
// rules and the on-screen behaviour will disagree.
const OWNER_EMAILS = [
  "shivi260121@gmail.com",
];

// 2) IMAGE HOSTING (Cloudinary — free, no billing card needed)
// Sign up at cloudinary.com, then see README step 3 for how to get these
// two values (a "cloud name" and an unsigned "upload preset").
const CLOUDINARY_CONFIG = {
  cloudName: "v9dk6xjx",
  uploadPreset: "zmfxi8vy",
};

// 3) UPI PAYMENT DETAILS
// You said you haven't linked UPI yet — fill this in whenever you do.
// Until then the QR code will still generate, it'll just point at a
// placeholder ID, so don't share the store link for real orders until
// this is set.
const UPI_CONFIG = {
  upiId: "yourupi@bank",        // e.g. "9999999999@ybl"
  payeeName: "The Wall Store",  // shown inside the buyer's UPI app
};

// 4) FIREBASE PROJECT CONFIG
const firebaseConfig = {
  apiKey: "AIzaSyBOPI_-jVxfu_mNttD-y-UuJt7yZ3w8Gcg",
  authDomain: "the-wall-store.firebaseapp.com",
  projectId: "the-wall-store",
  storageBucket: "the-wall-store.firebasestorage.app",
  messagingSenderId: "652307437221",
  appId: "1:652307437221:web:01001c850184ad9ba3df4c",
  measurementId: "G-9NTL9EN2VM",
};
