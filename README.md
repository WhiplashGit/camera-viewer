# Shop Cameras

A lightweight web viewer for the shop's Wave VMS system, hosted on GitHub Pages:
**https://whiplashgit.github.io/camera-viewer/**

- Sign in through Wave Cloud. Only a session token is stored, never the password.
- Pick, rename and hide cameras, and build groups that each show as a grid.
- Grids use small snapshots by default, which is much lighter than live video. Click a tile for live HD video.
- Rotate shows each camera in the current group full screen, one after another, on a timer.
- Motion pop-ups: the page checks every camera and pops one up only when a person, vehicle or animal moves (in-browser AI, COCO-SSD). Grass, leaves and lighting changes are ignored. Pop-ups stack on the right (newest picture-in-picture, up to 10, with Dismiss all). Starred key cameras get a red pulsing pop-up and can optionally take over the screen. Parked vehicles are ignored unless they actually move.
- Settings are personal: they save in each browser. Each person can save their own copy to the camera server under their name and a PIN, and load it on other devices. Nobody else's setup loads automatically.
- Right-click a camera (long-press on Android) for its name, star, motion, sound, picture and watch area.
- A watch area adds a separate zoomed '· area' view you can put in any group.
- Record or upload alert sounds, upload fun pop-up pictures, and put the menu bar on any side.

Keys: ←/→ switch groups (or cameras when one is open), 1–9 jump to a group, F full screen, R rotate, Esc closes a camera.
