# My LoL Esports Calendar

A static personal League of Legends esports calendar. It runs entirely in the browser, so it can be hosted for free with GitHub Pages.

## Files

- `index.html`
- `style.css`
- `app.js`
- `.nojekyll`

There is no Python server and no build step.

## Put it on GitHub Pages

1. Create a new GitHub repository, for example `lol-calendar`.
2. Upload **the files inside this folder** to the root of the repository.
3. Commit the files.
4. Open the repository's **Settings**.
5. Open **Pages** in the left sidebar.
6. Under **Build and deployment**, choose **Deploy from a branch**.
7. Select the `main` branch and `/ (root)`, then click **Save**.
8. After GitHub finishes deploying, the Pages section will show your public URL.

It will normally look like:

```text
https://YOUR-USERNAME.github.io/lol-calendar/
```

After that, you can bookmark the URL on your computer or phone.

## Updating it later

Edit files in GitHub or upload replacements and commit them. GitHub Pages republishes the site.

## Important note about the API key

This project follows the same browser-only architecture as static LoL esports projects: the unofficial LoL Esports API key is present in `app.js`, which means it is visible to anyone who can view the site source.

The key included here is the key documented in the OpenAPI file supplied for this project. Do not put a private or personal secret in a GitHub Pages JavaScript file.

## Troubleshooting

If the league list loads, direct browser access to the API is working.

If you see an API error in the status line, open your browser developer tools (F12), go to **Console** and **Network**, reload the page, and inspect the failed request. A screenshot of that error is enough to debug it.
