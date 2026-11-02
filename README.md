# Margin

Read the web in your own language. Margin is a Chrome extension (Manifest V3) with two halves that share one settings panel:

- **Selection toolbar.** Highlight text on any page to translate it, explain it in plain words, or hear it read aloud. The result appears in a card right next to the text you selected, with an arrow pointing at it, and follows the text as you scroll. Click anywhere else, press `Esc` or use the close button to dismiss it.
  - **One word selected:** the card also shows its meaning from Wiktionary and Wikipedia, with a link to read more. Words in Hindi, Bengali, Tamil, Telugu or Urdu script look in that language's Wikipedia; Latin-script words try the page's language, then English.
  - **A longer sentence selected:** the difficult words in it are listed with short meanings at the end of the card. With an API key the meanings come from Claude, in your language. In free mode, longer English words are looked up in dictionaryapi.dev, a rougher guess at which words are hard.
- **Page guide.** Right-click, press `Alt+Shift+E`, or use the toolbar popup to get an overlay that explains what every button, link and form field on the page does, what to do next, and flags anything that costs money or is hard to undo. Hovering an item highlights it on the page. Works offline with a basic rule-based guide when no API key is set.

All AI output is written in the language chosen in the popup. The translation card also has its own **Translate into** picker, so you can translate a selection into any supported language without changing your default.

## Install

1. Open `chrome://extensions` and switch on **Developer mode**.
2. Choose **Load unpacked** and select this folder.
3. Click the Margin icon, open **Settings**, paste an Anthropic API key and press **Save**.

Pages that were already open need a reload for the selection toolbar. The popup and right-click menu work immediately.

## Free mode

Without an API key, Translate works on short text (about 450 bytes) through MyMemory, and Explain defines single English words through dictionaryapi.dev. Wikipedia and Wiktionary meanings for single words work in free mode too. Sentences are explained by Chrome's built-in on-device model (Gemini Nano) once you turn it on in Settings: free, offline and private, but it needs a recent desktop Chrome and roughly 22 GB of free disk space, and it answers in English, Spanish, French or German (other languages get a translated answer). Long text and AI page guides need an API key.

## Privacy

The key is stored in `chrome.storage.local`. With a key, requests go straight from the browser to `api.anthropic.com`. In free mode, the selected text goes to `api.mymemory.translated.net` and `api.dictionaryapi.dev`. When a single word is selected, that word is also sent to Wikipedia and Wiktionary (`*.wikipedia.org`, `en.wiktionary.org`), with or without a key. Text typed into form fields, including password fields, is never read or sent. Page text is passed to the model as untrusted data.

## Files

| File | Role |
| --- | --- |
| `manifest.json` | permissions, shortcut, content script |
| `background.js` | context menu, shortcut, Anthropic API calls, Wikipedia/Wiktionary and dictionary lookups |
| `content.js` | selection toolbar, result card placed beside the selection, page guide overlay (closed shadow DOM) |
| `offscreen.html/js` | hidden page that runs Chrome's on-device AI |
| `popup.html/css/js` | quick actions and settings |
