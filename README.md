<div align="center">

# t3+ for T3 Code

Pixel-art bots, profiles, a dithered glow and usage widgets for the T3 Code desktop app.

<img src="media/hero.gif" alt="t3+ new-thread page: glow behind a glass composer, usage widgets, bots in the sidebar" width="100%">

[Install](#install) · [Glow](#glow-and-glass) · [Sidebar](#sidebar) · [Usage](#usage) · [Settings](#settings) · [Walkthrough](#walkthrough)

</div>

## Install

You need macOS, the T3 Code desktop app and Node 22.2+. Copy this to your coding agent (Claude Code, Codex or T3 Code itself):

```text
Install t3+ for T3 Code on this Mac:
1. git clone https://github.com/arjundgupta/t3plus ~/.t3plus
2. sh ~/.t3plus/build.sh   (needs Node 22.2 or newer)
3. With T3 Code open: node ~/.t3plus/t3plus.mjs on
4. Load it every time T3 Code starts:
   mkdir -p ~/Library/LaunchAgents && sed "s#__HOME__#$HOME#g" ~/.t3plus/launchd/com.t3plus.autostart.plist > ~/Library/LaunchAgents/com.t3plus.autostart.plist && (launchctl bootout gui/$(id -u)/com.t3plus.autostart 2>/dev/null; launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.t3plus.autostart.plist)
```

Settings are in T3 Code under Settings → t3+.

- **Update:** `git -C ~/.t3plus pull && sh ~/.t3plus/build.sh && node ~/.t3plus/t3plus.mjs on`
- **Turn off:** `node ~/.t3plus/t3plus.mjs off` (it loads again when T3 Code restarts)
- **Uninstall:** `launchctl bootout gui/$(id -u)/com.t3plus.autostart; rm ~/Library/LaunchAgents/com.t3plus.autostart.plist; node ~/.t3plus/t3plus.mjs off; rm -rf ~/.t3plus`

## Glow and glass

A dithered glow sits behind a glass composer. It uses your T3 theme color, or any color you pick.

<img src="media/accent.gif" alt="The glow cycling through accent colors" width="100%">

Three pixel looks, plus a smooth one:

| Bayer | Grain | Spectrum |
|:---:|:---:|:---:|
| <img src="media/look-bayer.png" alt="Bayer look"> | <img src="media/look-grain.png" alt="Grain look"> | <img src="media/look-spectrum.png" alt="Spectrum look"> |

Or use your own image:

<img src="media/image-mode.png" alt="Image background behind the new-thread page" width="100%">

## Sidebar

<table>
<tr>
<th width="33%">Bots</th>
<th width="33%">Profiles</th>
<th width="33%">Status view</th>
</tr>
<tr valign="top">
<td><img src="media/bots.gif" alt="Bots in the sidebar: animated faces, latest messages and a subagent strip" width="100%"></td>
<td><img src="media/profiles.gif" alt="Swiping between two profiles: the list slides and the sky changes color" width="100%"></td>
<td><img src="media/status.gif" alt="The Status view: threads grouped by status, with bots in status colors, sliding between profiles" width="100%"></td>
</tr>
<tr valign="top">
<td>

Every thread is a pixel-art bot with a face, a name and its latest message.

- **Moods:** eyes closed when idle, animated while working.
- **Subagents:** small faces under the bot. Finished ones dim.
- **Status badges:** a tile on each face. Off by default.
- **Looks:** pick a shape and color per bot.

</td>
<td>

Dots at the bottom of the sidebar. Each profile has its own projects and open thread.

- **Switch:** swipe with two fingers, click a dot, or press Ctrl+Shift+1–9.
- **Move a project:** drag it onto a dot, or right-click it.
- **Edit:** right-click a dot to rename it or set its icon and colors.

</td>
<td>

The button next to the dots groups threads into Needs you, Working, Done and Idle.

- **Complete:** shows threads T3's list hides, like approvals and failed runs.
- **Status colors:** orange needs you, red failed, yellow working, green done, blue idle. Off by default.
- **Swipe:** switches profiles here too.

</td>
</tr>
</table>

Five styles for bots you haven't customized:

| Classic | Sports | Space | Fruit | Blobs |
|:---:|:---:|:---:|:---:|:---:|
| <img src="media/style-classic.png" width="150" alt="Classic bots"> | <img src="media/style-sports.png" width="150" alt="Sports bots"> | <img src="media/style-space.png" width="150" alt="Space bots"> | <img src="media/style-fruit.png" width="150" alt="Fruit bots"> | <img src="media/style-blobs.gif" width="150" alt="Blobs bots, gently animated"> |

Blobs are always moving. They look around, blink and breathe.

## Usage

Under the new-thread composer: your Codex and Claude pools, a tokens-per-day heatmap and this month's spend. Hover for details.

<img src="media/widgets.gif" alt="Hovering the pool, usage and activity widgets" width="100%">

<table>
<tr>
<td width="260"><img src="media/details.png" alt="Thread details with the Claude pool and the thread's spend" width="260"></td>
<td>

Thread details show the provider's pool and what the thread has cost.

All data is read on your Mac, from T3's database, T3's local API and your Claude and Codex logs. t3+ makes no network requests.

</td>
</tr>
</table>

## Settings

Everything is in Settings → t3+, with previews.

<img src="media/settings.png" alt="The t3+ section in T3 Code's settings: the Applying bar and the background preview" width="100%">

- **Per profile and device:** the bar at the top picks what you're changing. Use for all makes a setting the same everywhere again.
- **Changelog:** at the bottom. Click it to see what changed.

<img src="media/settings-features.png" alt="t3+ features in Settings: bot style, status colors with a preview, status badges, subagents" width="100%">

## Walkthrough

[![Watch the 50-second walkthrough](media/walkthrough-poster.png)](media/walkthrough.mp4)

## License

PolyForm Noncommercial 1.0.0. See [LICENSE](LICENSE).
