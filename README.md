# Bionet desktop

A lab's freezer, kept by the people in the lab. It works with no network, and syncs when there is one.

![The freezer](docs/freezer.png)

## What it is

Each person runs this on their own computer. Everything they do — add a part, add a tube, use some,
count what is left, let somebody into the lab — becomes a **signed entry in that device's own log**,
kept in a SQLite file beside the app. Nobody writes to anybody else's log, so two people working
offline cannot overwrite each other. What the lab holds is worked out from all the logs together by
[`@biolibs/bionet`](https://www.npmjs.com/package/@biolibs/bionet), the same way on every machine.

The lab's **web peer** (see [lab-wren](https://github.com/matthewlovestocode/lab-wren)) is a server at
the lab's address that holds a copy and passes changes between members who are never online together.
It has no key, so it cannot change anything. The app works without it and catches up when it is there.

- **The device's key never leaves the computer.** It is sealed by the operating system's keychain.
  One person with two computers is two devices on the roster.
- **Amounts are whole numbers of a unit**, recorded as differences. Two people each using a tube are
  two uses. A recount says what is physically there.
- **A change the lab would refuse is never written.** A log is forever, so the app tries a change
  against the lab first and says why if it will not go.
- **The window has no powers.** It cannot read files, reach the network or see the key. It can ask for
  the lab's state and for one of a fixed list of things to be done.

## Running it

```
npm install
npm run dev
```

A second device on the same machine, for trying two members side by side:

```
npm start -- --profile=bob
```

## Joining a lab

1. The new member opens the app, says who they are, and sends a keeper **their device's key**.
2. A keeper adds that key under People, and sends back the **invitation**.
3. The new member pastes the invitation. The lab arrives once the keeper's change has reached the peer.

## Trying it without a person

Both of these start the real web peer from `../lab-wren` (run `npm run build` there first).

| Command | What it does |
|---|---|
| `npm run try-core` | Two devices with no windows: founding, joining, live changes, offline work that converges, refusals, publishing, quitting and reopening |
| `npm run try-app` | The real app as two devices, driven through the same door the window uses, photographing each step |

## Layout

```
src/core/      the app without a window: plain Node, no Electron
  lab.mjs        one device in one lab, and everything it can do
  peer-link.mjs  the connection to the web peer; allowed to fail
  store.mjs      the SQLite file: entries and a few settings
src/main/      the window around it: keychain, IPC, nothing else
src/renderer/  what is drawn: React, given the lab as plain data
```

## Not yet

- Removing somebody from the lab (the rule exists in `@biolibs/bionet`; there is no button).
- Editing a part's or a tube's fields, and locations.
- Choosing which other labs this one points at. Publishing keeps the pointers already published.
- Direct connections between devices. Everything goes through the web peer.
- Installers, signing and updates. It runs from source.
- Backing up or moving a device's key.

## License

MIT. See [LICENSE](LICENSE).
