# Friendly Chess

Free 1v1 chess for you and a friend. Open the site, click **Create game**, send your friend the link, play.
No accounts, no ads, no database, no server to run.

## How it works
- The whole site is static files (`index.html`, `style.css`, `app.js`, `chess.js`).
- Moves travel directly between the two browsers over WebRTC using [PeerJS](https://peerjs.com).
  PeerJS's free public broker only helps the two browsers find each other. It never sees your moves.
- The host's browser is the "game room": keep that tab open. If either player refreshes, they reconnect
  and the position is restored automatically.

## Put it online (free, ~1 minute)
Your friend needs a real URL, so host the folder somewhere. Any of these is free and needs no build step:

1. **Netlify Drop** (easiest): go to https://app.netlify.com/drop and drag this whole folder onto the page.
   You get a URL like `https://something.netlify.app` instantly.
2. **GitHub Pages**: push the folder to a repo, then Settings → Pages → deploy from the `main` branch.
3. **Cloudflare Pages** or **Vercel**: create a project from the folder / repo, no build command, output dir `/`.

Then open your URL, click **Create game**, and send the generated link to your friend.

## Run it locally (for testing)
    python3 -m http.server 8000
then open http://localhost:8000 in two browser tabs (create a game in one, paste the link into the other).

## Features
Full chess rules (castling, en passant, promotion, check/checkmate/stalemate, threefold repetition,
fifty-move rule, insufficient material), click or drag to move, legal-move hints, move list in
algebraic notation, captured pieces, resign, draw offers, rematch (colors swap), chat, sound,
works on phones, plus pass-and-play on one screen.

## Tests
    node perft.test.js
checks the move generator against the standard published perft node counts.

## Limits
- Very strict corporate/school networks can block WebRTC. Home Wi-Fi and mobile data work fine.
- There are no clocks yet and no accounts or ratings.
