# Gallery and privacy

The gallery is where people share skins. Browsing and downloading need no account; uploading needs a Google sign-in and a public name. This page covers how that works and what is stored.

The formal versions are the [privacy policy](https://bowen1314.github.io/claude-skin-switcher/privacy.html) and [terms](https://bowen1314.github.io/claude-skin-switcher/terms.html).

## Browsing and downloading

- Open **Gallery** in the app to see the newest or most popular skins, search by name, or filter by tag.
- Open a skin for its details, palette, preview and **Code** tab, then click **Download**. It lands in your library, checked by the same rules the gallery uses ([security](security.md)).
- Downloads are counted once per network per skin per day, so the popular list is hard to inflate.

## Signing in

You only need to sign in to upload. The app opens Google in your browser and asks for the `openid` scope only. That means Google tells the gallery an account id and nothing else: not your email address, name or photo. After you approve, the browser hands the result back to the app, and the app comes to the front.

On your computer, the app keeps only Google's refresh token, encrypted with your system keychain. On macOS the first sign-in asks to use "Claude Skin Switcher Safe Storage"; choose **Always Allow**. **Sign out** deletes the token.

## Your public name

The first time you upload, you pick a public name (a handle), such as `ocean-fan`. Your skins appear as `<handle>.<skin-slug>`.

- 3 to 32 characters: lowercase letters, digits and hyphens, starting and ending with a letter or digit.
- Unique: no two accounts can have the same name.
- Reserved: `official`, `claude`, `anthropic`, `admin`, `gallery` and a few others can't be taken.
- You can change it until you have uploaded skins; after that it's locked to keep links stable. Delete your skins to change it.

## Uploading

- Make a skin with **Save as new…** after tuning, or write one by hand and use **Upload → Import folder…** ([skin format](skin-format.md)).
- The app checks the skin before sending it and lists every problem. The gallery checks it again.
- Uploading a skin with the same slug publishes a new version of it.
- At most 10 uploads per account per day, and 300 KB per upload.
- Only skins you made can be uploaded. Skins you downloaded from the gallery and the built-in skins stay out of the upload list, and copies are refused, by the app and by the gallery: a skin with a backdrop scene is refused even recolored or renamed; a skin with only colors and style is refused if it is the same apart from its name, description and tags.
- A skin made with **Save as new…** from a gallery or built-in skin is a remix: it remembers the original, can be uploaded, and shows "Remix of <name> by <author>" in the gallery.
- By uploading you confirm you have the right to share the skin and you license it for anyone to use ([terms](https://bowen1314.github.io/claude-skin-switcher/terms.html)).

## Deleting and reporting

- **Delete** removes your own skin from the gallery right away. People who already downloaded it keep their copy.
- **Report** flags a skin that is offensive, misleading or infringing. Each network can report a skin once; at three reports the skin is hidden until a person reviews it.
- Accounts that upload abusive skins can be blocked; their skins are hidden.

## What is stored

| Data | Where | Public? |
|---|---|---|
| Your skins, their versions and dates | gallery database | yes |
| Your public name | gallery database | yes |
| A salted one-way hash of your Google account id | gallery database | no |
| A salted one-way hash of your network address, for download counts and reports | gallery database | no |
| Google refresh token | your computer, encrypted | no |
| Your email, name, photo, the raw Google id, your IP address | **not stored anywhere** | — |

The gallery runs on Cloudflare Workers and D1, which process requests to serve it. Nothing is sold or shared. Questions go to [GitHub issues](https://github.com/Bowen1314/claude-skin-switcher/issues).
