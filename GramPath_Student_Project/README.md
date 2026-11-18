# GramPath | UP Scholarship Guide

A student project for checking basic UP Scholarship requirements, preparing documents and planning around an application deadline.

## Run it in VS Code

1. Install Node.js 22 or newer and Python 3.10 or newer. On Windows, `py --version` can confirm the installed version.
2. Open the extracted project folder in VS Code. It should contain `package.json`.
3. Open **Terminal → New Terminal** and run:

   ```powershell
   npm ci
   npm start
   ```

4. Keep the terminal open and visit [http://127.0.0.1:3000](http://127.0.0.1:3000).

On Windows, the server tries the `py` launcher first. If you prefer to choose a specific Python command or executable, set `PYTHON_BIN` in `.env`. The optional `START_WINDOWS.bat` runs the same setup. The Node server supplies the web page and API at port 3000, so use that address when testing the form.

## Try the project

- Click **Use a sample profile**, then **Check eligibility**. Change the income or domicile and run the check again. Each condition has its own explanation.
- Mark an item **Ready** under **Document checklist**, then reload the page to see the saved status.
- Click **Try a five-day example** under the deadline section. The example gives a student five days to apply and seven days to prepare a missing document. You can change either input and compare again.
- Try a sample JPG or PNG under **Check a scan before uploading**. Canvas measures basic image quality in the browser.
- Under **Help**, choose a payment problem to see the relevant next steps and official links.

## How the code is organised

| File | What it does |
| --- | --- |
| `index.html` | The page, forms and navigation |
| `assets/style.css` | Layout, colours and mobile styles |
| `assets/app.js` | The form requests, results, checklist, date comparison and browser image check |
| `gateway.js` | The Node/Express server that serves the page and sends API requests to Python |
| `server.py` | Python eligibility rules, official-source records and SQLite queries |

Follow the eligibility request from `checkElig()` in `assets/app.js` to `check_eligibility()` in `server.py`. The page sends a JSON request to `POST /api/eligibility`. Python reads the stored rule, checks the answers and returns a list of reasons. SQLite is created automatically the first time the server runs.

## Scholarship data

The database ships with manually curated records. Each result is preliminary. Check current requirements, dates and any exceptions at the [official UP Scholarship portal](https://scholarship.up.gov.in/). The image checker reports quality issues. The issuer handles document verification. The Help section searches a small stored guide and links to official payment and support channels. Eligibility form answers are processed by the backend for the check. The app saves document statuses in the browser.

## Admin and deployment

The local development server prints a temporary admin key. Use **Database editor** in the footer to add or update records. The public deployment configuration defaults to admin editing disabled. The gateway uses Helmet, API rate limits and a private loopback connection to Python. Cloudflare Tunnel and WAF setup are documented in [SECURITY_DEPLOYMENT.md](SECURITY_DEPLOYMENT.md) and require your own domain and Cloudflare configuration.

## Run the tests

```powershell
npm test
```

The tests start the same Node and Python servers used by the app, on separate local ports and with a temporary SQLite database. They check income limits, rejected inputs, the document checklist, saved progress, deadline calculations, and how the eligibility form handles errors. They also check the response headers, admin restrictions, and request limit. The page tests use a DOM simulator, so a separate browser installation is unnecessary.

Run `npm run check` for JavaScript syntax checks. The original Python smoke test is also available through `python tests/smoke_test.py` or `py tests/smoke_test.py` on Windows.
