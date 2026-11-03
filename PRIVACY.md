# Margin: Privacy Policy

_Last updated: 3 November 2026_

Margin is a Chrome extension that translates, explains and reads aloud text, and explains the buttons and forms on a web page. This policy describes what data it handles.

## What Margin does with your data

Margin only processes data when you ask it to: when you use the toolbar that appears on selected text, the popup, the right-click menu, or the `Alt+Shift+E` shortcut. It does not run in the background, track you, or build a profile.

**When you select text and press Translate or Explain**
- The selected text, and the title of the current page, is sent to the service that handles the request:
  - **With a Gemini API key:** to Google's Gemini API (`generativelanguage.googleapis.com`).
  - **In free mode (no key):** to `api.mymemory.translated.net` (translation) and `api.dictionaryapi.dev` (English word definitions).
  - **On-device AI (optional):** processed locally by Chrome's built-in model. Nothing leaves your device.
- If you select a single word, that word is also sent to Wikipedia and Wiktionary (`*.wikipedia.org`, `en.wiktionary.org`) to show its meaning.

**When you use the page guide**
- With a Gemini API key, Margin sends the page's title, address (without query string), headings, a short excerpt of visible text, the labels of visible buttons, links and form fields, and any text you had selected to Google's Gemini API.
- Without a key, the guide is built on your device with simple rules and nothing is sent.

**What Margin never reads or sends**
- Anything typed into text boxes, form fields or password fields.
- Your browsing history, cookies or account information.

## What is stored

Margin stores your language preference and, if you enter them, your Gemini API key and chosen model name. These are kept in `chrome.storage.local` on your own device. They are never sent anywhere except the API key, which is sent to Google when you use AI features. The developers of Margin have no server and cannot see your key or your text.

## Third parties

Text you submit is handled by the services above under their own terms and privacy policies: Google (Gemini API), MyMemory, dictionaryapi.dev, Wikipedia and Wiktionary. If you use Google's Gemini API on a free tier, Google's terms may allow it to use submitted content to improve its products. Use a paid key or the on-device option if that is a concern.

## What we do not do

We do not sell or transfer user data to third parties for any purpose other than providing Margin's features. We do not use or transfer user data for advertising, creditworthiness or lending. We do not use remote code: all of Margin's code is included in the extension package.

## Contact

Questions about this policy: open an issue at https://github.com/deva23015/margin/issues.
