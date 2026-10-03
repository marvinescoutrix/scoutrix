# Hosting Scoutrix

## Free demo deployment

The default [Render Blueprint](./render.yaml) creates a free Node web service. It is suitable for previewing the site with sample information, not for managing real scout or competition records.

Render's free web services sleep after 15 minutes without traffic and have an ephemeral filesystem. Local data files and uploaded photos can be lost whenever the service sleeps, restarts, or redeploys. The app displays a warning in demo mode for this reason. See [Render's free service limits](https://render.com/docs/free).

To deploy:

1. Create a private repository on GitHub and upload this project. Do not commit `.env`, `data/`, or real participant information; `.gitignore` excludes these.
2. In Render, choose **New > Blueprint**, connect the repository, and use `render.yaml` as the Blueprint file.
3. Deploy the Blueprint. Render generates the public `onrender.com` service URL after the first successful deployment.
4. Find the generated `ORGANIZER_SETUP_KEY` in the Render service's environment settings. Open the Render URL, set up the first organizer, and use only sample data in the free demo.

The initial request can take about a minute while the free service wakes up. A deployable public URL cannot be assigned until the project is pushed to a Git provider and deployed from a Render account.

## Install on Android

1. Open the live website in Chrome on the Android phone: <https://scoutrix-ksa-competition-free.onrender.com/>.
2. Open Chrome's three-dot menu and tap **Install app** (or **Add to Home screen**), then confirm.
3. Launch **KSA Competition** from the new home-screen icon. It opens in an app-style window and still needs an internet connection.

The installed shortcut uses the same live website and account; it is not a separate offline app. Do not use this free demo for real participant records.

## Paid hosting for real competition data

The separate [paid Render Blueprint](./render-paid.yaml) attaches a persistent disk for the JSON database and uploaded photos. To use it, select `render-paid.yaml` as the Blueprint file when creating the paid service, or update the existing service configuration to match it. The persistent disk is not a backup; arrange regular backups before using real records.

After moving from the free demo to paid hosting, create a new organizer account and assessor accounts on the paid service. Free-instance data is not a safe or reliable way to migrate real participant records.

## Local first-organizer setup

For a local run without `ORGANIZER_SETUP_KEY`, the server generates a random key at `data/organizer-setup-key.txt` and logs its file path. Read the key from that local file and enter it in the first-organizer form. Do not publish or commit the file.

## Operational notes

- The JSON file store is intended for a single service instance. Do not scale the service to multiple instances.
- User sessions are held in memory, so users must sign in again after a service restart or deploy.
- Test registration, assessment, downloads, and reports with non-sensitive sample records before opening the competition to real users.
