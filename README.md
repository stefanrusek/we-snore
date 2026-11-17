# We Snore™

One phone on the nightstand, everyone in the room on trial. Listens all night, finds the snores, and uses frequency analysis to work out how many different snorers there are and who did how much.

No build step, no dependencies, no server: audio is analysed on the device and never leaves it.

## Run it

```sh
npm start          # python3 -m http.server 8765  ->  http://localhost:8765
npm test           # engine tests against synthetic nights
```

Browsers only allow the microphone on `localhost` or over **https**, so to use it on a phone, put this folder on any static https host (GitHub Pages, Netlify, Cloudflare Pages) and "Add to Home Screen".

`/#demo` runs a time-lapse demo night with two synthetic snorers.

## How it tells snorers apart

1. Mic audio (phone voice processing switched off) is decimated to ~16 kHz, cut into 64 ms frames, and turned into 32 mel bands (60 Hz – 4 kHz).
2. An adaptive noise floor tracks the room's quiet. Bursts 0.25–5 s long that rise above it are sound events.
3. Snores come in trains, so an event only counts if it has neighbours within 30 s. One-off coughs and door thuds are dropped.
4. Each snore gets a "snoreprint": 12 mel-cepstral coefficients of the noise-subtracted spectrum (the airway's resonances), its pitch (autocorrelation), and its loudness (who is nearer the phone).
5. k-means groups the snoreprints, for k up to the number of sleepers. A split is only accepted if the groups are clearly separated with an empty gap between them, so one person with a variable snore isn't counted as two.
6. In the morning you listen to samples of each snorer and name them. Named snoreprints are saved and recognised on later nights.

## Known limits

- When two people snore in the very same breath, that snore is credited to the louder one, so the quieter snorer is under-counted during overlaps.
- Two people with very similar snores at similar distances are reported as one snorer.
- Sleep-talking in a steady rhythm can be counted as snoring.
- Loudness is relative to room quiet, not calibrated dB. It is not a medical device.
- The page has to stay open with the screen on (it holds a wake lock and dims itself). Keep the phone plugged in.
- "Analyze a recording" decodes the whole file in memory: about an hour of audio at most.

## Files

- `engine.js`: DSP, event detection, clustering, report maths (pure JS, also runs in Node)
- `synth.js`: synthetic snorers for the demo and tests
- `worklet.js`: microphone capture
- `app.js`, `index.html`: UI

## License

MIT
