# Changelog

## [1.1.0](https://github.com/ichabodcole/spellbook/compare/spellbook-v1.0.0...spellbook-v1.1.0) (2026-06-11)


### Features

* **grapevine:** V1.7 — human as a first-class participant ([2187404](https://github.com/ichabodcole/spellbook/commit/21874043a19e9d1df9772b6468b63ff60a9d535c))

## [1.0.0](https://github.com/ichabodcole/spellbook/compare/spellbook-v0.1.0...spellbook-v1.0.0) (2026-06-11)


### ⚠ BREAKING CHANGES

* the `tuskboard` spell is renamed to `bounty`; its skill folder, trigger phrases, and ${CLAUDE_PLUGIN_ROOT} script paths all change.

### Features

* bring the spells home — migrate digestify, grapevine, tuskboard, magpie ([bd69857](https://github.com/ichabodcole/spellbook/commit/bd69857343d2070fd49853fb1feba64a4ffa7548))
* **glamour:** agent→user narration feed + cli narrate verb ([608e81e](https://github.com/ichabodcole/spellbook/commit/608e81e529744680b63e5c36d41f4e7e413ae5e9))
* **glamour:** always-on FeedbackBar (FEAT-3) + terminal-handoff banner (FEAT-2) ([65e815c](https://github.com/ichabodcole/spellbook/commit/65e815c774b576e2d6969bd1f2ddb9e467c2ba88))
* **glamour:** Analysis phase component ([aff235a](https://github.com/ichabodcole/spellbook/commit/aff235a837d9661ca697e5d8621380464095998c))
* **glamour:** assemble 3-pane StudioShell; retire single-column phases ([0a0cbf1](https://github.com/ichabodcole/spellbook/commit/0a0cbf10c4e92854a5afce32b6efc04f671a245a))
* **glamour:** center studio — gather (annotate), analysis (batched feedback), direction ([8095d50](https://github.com/ichabodcole/spellbook/commit/8095d50fc1619b88a22b0215f8830905f08ddfaf))
* **glamour:** center studio prompts/variants/gallery + spec pane (right) ([12e833b](https://github.com/ichabodcole/spellbook/commit/12e833b77e2757f451979e2a051f840c17fa736a))
* **glamour:** correct/augment mode on direction feedback + FeedbackControl ([2d1e15d](https://github.com/ichabodcole/spellbook/commit/2d1e15dbb9e153ce06f5aa7e97d1778eac038774))
* **glamour:** cost + handoff fields, note channel, single-canonical selection ([69a9228](https://github.com/ichabodcole/spellbook/commit/69a922893ac94ef5536436a042060e3d8a065577))
* **glamour:** Direction phase component with correct/augment feedback ([6cabeec](https://github.com/ichabodcole/spellbook/commit/6cabeecf610fa0af6ad81abbec5d58bc6a75609e))
* **glamour:** fix SKILL gaps found by the fresh-agent cold pass ([00db64b](https://github.com/ichabodcole/spellbook/commit/00db64b4ec31fe6098e94e5258f0cd97aa0ad324))
* **glamour:** forward-only phase auto-advance on artifact post ([db9204c](https://github.com/ichabodcole/spellbook/commit/db9204cdfb78e012e771b94476a3313186d65002))
* **glamour:** Gather phase as React components (context-only intake; inline annotate) ([efcf843](https://github.com/ichabodcole/spellbook/commit/efcf84355a5c50edff8030e61bb6099019263e0f))
* **glamour:** influence pane (left) with select-to-annotate + file intake util ([77f3e04](https://github.com/ichabodcole/spellbook/commit/77f3e045676df993145f37c590cb372bd86cb2b9))
* **glamour:** lean /state projection (drops inlined src); cli state defaults lean ([65dcada](https://github.com/ichabodcole/spellbook/commit/65dcada0b33cecd5c7217817816576143f06acae))
* **glamour:** Lightbox component (true-aspect, esc/click-out) ([afefa90](https://github.com/ichabodcole/spellbook/commit/afefa90f3fddbecd5a0cb12ab238bb7819defe00))
* **glamour:** optimize agent-posted variants server-side before inlining ([15bb433](https://github.com/ichabodcole/spellbook/commit/15bb4332b04d04bcda8bb2cbefe7405afbd5bb95))
* **glamour:** Prompts phase component with generate ([09a48f3](https://github.com/ichabodcole/spellbook/commit/09a48f3026de1c0485648a54b0b7d777912965fa))
* **glamour:** React+Bun surface scaffold + WS client shell; serve bundle ([bae5300](https://github.com/ichabodcole/spellbook/commit/bae5300d9b79c2522e4ac78a25a4a77e6b788145))
* **glamour:** rebuild surface as 3-pane React studio (Plans 1-4) ([ee992af](https://github.com/ichabodcole/spellbook/commit/ee992af3bc906d5ab1b1560b6efc29e71cc2e027))
* **glamour:** refresh media-forge routing brain for live transform ops ([17244d2](https://github.com/ichabodcole/spellbook/commit/17244d2f0759291e1033751c5272979b3f836455))
* **glamour:** round grouping in Variants + choice indicators on Spec gallery ([0fccfb7](https://github.com/ichabodcole/spellbook/commit/0fccfb705e71552690ff5cbef7cab519cd24219d))
* **glamour:** route image generation by content-type + per-model prompt structure ([235daad](https://github.com/ichabodcole/spellbook/commit/235daad5950ed77151cf50ceeb2a6085a94f15b8))
* **glamour:** server uses shared types; add narration + spec-module content ([7b94405](https://github.com/ichabodcole/spellbook/commit/7b944051546495a5da4b3fd8efe2647f7289e1c3))
* **glamour:** shared image-optimize util (sharp) for variant path ([dc1835b](https://github.com/ichabodcole/spellbook/commit/dc1835b0db2e38f1f5cb9adc88514b977bc0849e))
* **glamour:** shared typed state + event contract for surface rebuild ([4bde0e5](https://github.com/ichabodcole/spellbook/commit/4bde0e5d2533f00c0ada8c8a38e9ea754aac3f12))
* **glamour:** ship glamour — sync listings, registry, grimoire ([15adb06](https://github.com/ichabodcole/spellbook/commit/15adb066c2f4f0b4e5a1046e5d59d4de96df1800))
* **glamour:** Spec phase (modules, recreate prompt, canonical selection) ([f9538dd](https://github.com/ichabodcole/spellbook/commit/f9538ddcec008ac98e8bfa333b87198f5beafd5a))
* **glamour:** studio foundation — lucide, component CSS classes, constants, atLeast ([10ddff3](https://github.com/ichabodcole/spellbook/commit/10ddff3d39630c4f182ba95540325ca8caccbdc5))
* **glamour:** studio shell chrome (header, stepper, working banner, footer, ended overlay) ([1e26229](https://github.com/ichabodcole/spellbook/commit/1e26229bcfeca9d02ce612112be2f522abdb4a33))
* **glamour:** Variants phase (round grouping, like, lightbox, cost) ([33581f6](https://github.com/ichabodcole/spellbook/commit/33581f65ed00cc54b7205ca831f9aa95d9ba1241))
* rename tuskboard spell to bounty, add Review column ([51dd7b5](https://github.com/ichabodcole/spellbook/commit/51dd7b5e1c5f24f051b11c12f5c124e342515265))
* scaffold glamour spell (WIP) — compose a visual style ([7f49040](https://github.com/ichabodcole/spellbook/commit/7f49040a45cd3e219d383c6b03a785b4ab3ea7ff))
* wire real image generation into glamour via media-forge ([c306f6b](https://github.com/ichabodcole/spellbook/commit/c306f6bb342c1be8b01412049bafea7209cdccdd))


### Bug Fixes

* **glamour:** dismissable variant prompt overlay (click to close) ([b9a24bb](https://github.com/ichabodcole/spellbook/commit/b9a24bb81df68d5165193a6fb5c3fdfd072401ba))
* **glamour:** DropZone fails safe — throw on null canvas ctx, per-file error isolation ([0243532](https://github.com/ichabodcole/spellbook/commit/02435322b614edfa4f8a09e9362c700a0742b6aa))
* **glamour:** FeedbackBar discards draft on close ([3766a97](https://github.com/ichabodcole/spellbook/commit/3766a9751d322b99a14f90f62e440e78835e1c3e))
* **glamour:** guard Generate button when there are no prompts ([d28b16f](https://github.com/ichabodcole/spellbook/commit/d28b16f65385b36654218d5f1b747999f9bf06ac))
* **glamour:** handle message WS frames; lean state comment + context.path test ([e3cc02e](https://github.com/ichabodcole/spellbook/commit/e3cc02e1a0d08f76032f004332e95ed36dae0d18))
* **glamour:** launch daemon from glamour root so bunfig/Tailwind loads ([00f7138](https://github.com/ichabodcole/spellbook/commit/00f7138831da64a7030e7785088d614ba15a2603))
* **glamour:** media-forge reference — image refs now live, corrections ([c2a9b89](https://github.com/ichabodcole/spellbook/commit/c2a9b89b11a2591544064fce382be3e1aec8361e))
* **glamour:** narration overlay spacer, role=log, cli --kind validation ([1f51fd8](https://github.com/ichabodcole/spellbook/commit/1f51fd84905bb56b79cb82faa819a15444126758))
* **glamour:** revision 0 on first direction; dedupe analysis.comment; validate prompt.comment id ([d82c211](https://github.com/ichabodcole/spellbook/commit/d82c2110fdde9ff15706712fdfb7d2ea2485d8a4))
* **glamour:** WS hook derives wss/ws + stops reconnecting after session end ([faffda5](https://github.com/ichabodcole/spellbook/commit/faffda513e88fbbc27e08e5dd36708d0c246a409))
* **grapevine:** scope stderr-fold advice to the consumer (don't flood Monitor) ([47c1cbd](https://github.com/ichabodcole/spellbook/commit/47c1cbdb78e98f92710e3231b8eb8cd438973f16))
