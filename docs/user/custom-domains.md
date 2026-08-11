# Custom Domains for Stasher News Turfs

Custom domains is a private beta feature that let a Stasher News turf run on its own domain.

Instead of sending people to a turf URL like:

`https://stasher.news/~yourterritory`

you can point a subdomain you control to your turf, such as:

`https://forum.yourdomain.com`

Your turf will still be powered by Stasher News, but visitors can browse, post, sign up, log in, and read your turf from your own subdomain.

# Who can use this feature?

Custom domains are currently available in private beta for selected turf founders.

To use a custom domain, you need:

* an active Stasher News turf
* ownership or DNS access for the subdomain you want to use
* access to the private beta
* the ability to create DNS records with your domain registrar or DNS host

# What changes when I add a custom domain?

Your turf gets a standalone-looking home on the web.

For example, instead of links like:

`stasher.news/~yourterritory/post`

your custom domain can use cleaner turf-specific paths like:

`forum.yourdomain.com/post`

The custom domain is still connected to Stasher News. Posts, comments, tips, accounts, rewards, and turf rules continue to work through SN.

# What can I customize?

After adding a custom domain, you can customize the presentation of your turf.

Available branding options include:

* site title
* tagline or meta description
* logo
* favicon
* primary color
* secondary color
* link color

# How to add a custom domain

Setting up a custom domain for your turf is very simple, requiring very little beyond editing a few DNS records.

If you are interested in being part of our private beta, reach out to stasher [email here?]. After you have been added to the beta, do the following:

1. Go to your turf settings.
2. Open the advanced settings section.
3. Enter the domain you want to use.
4. Save the domain.
5. Follow the DNS instructions shown on the page.
6. Wait for Stasher News to verify your DNS and SSL setup.
7. Once verification succeeds, your turf will be available at your custom domain.

## DNS setup

To prove that you control the domain, you will be asked to add DNS records.

The exact records will be shown in your turf settings after you save your custom domain.

You should expect to add records such as:

* a CNAME record that points your custom domain to Stasher News
* one or more verification records used to confirm domain ownership and issue SSL

DNS changes can take time to propagate. Some DNS hosts update within minutes, while others may take longer.

## SSL setup

Stasher News handles SSL certificate issuance for custom domains.

You do not need to upload or manage your own certificate. After the required DNS records are added, Stasher News will verify the domain and attach the certificate automatically.

Your domain is not fully active until both DNS and SSL verification are complete.

## Domain status

Your custom domain may show one of several states during setup:

### Pending

The domain has been saved, but verification is still in progress. You may still need to add or correct DNS records.

### Active / Verified

The domain has been verified and is ready to use.

### Hold

The domain is paused because verification failed, DNS changed, the turf stopped, or the domain needs to be re-verified.

If your domain enters a hold state, check your DNS records and follow the verification steps again.

## Logging in on a custom domain

Because browsers treat each domain separately, your normal Stasher News login session does not automatically transfer to a custom domain.

When you log in or sign up from a custom domain, Stasher News will securely route you through the main Stasher News authentication flow and then return you to the custom domain.

In practice, this should feel like a normal login flow.

## What happens if my DNS changes later?

Stasher News may continue checking active custom domains.

If your domain no longer points to Stasher News, the custom domain may be placed on hold until it is fixed and re-verified.

This protects both turf owners and visitors from stale or hijacked domain configurations.

## Example

A beta example is:

`https://links.sox.sk/`

This is a custom-domain version of a Stasher News turf. It keeps the SN-powered posting and tipping experience while presenting the turf on its own domain with custom branding.

## Troubleshooting

### My domain is still pending

Check that all required DNS records were copied exactly. DNS propagation may also take time.

### My DNS host does not allow CNAME records at the root domain

Use a subdomain such as `www.yourdomain.com`, `links.yourdomain.com`, or `forum.yourdomain.com`.

### My domain was working, then stopped

Check whether the CNAME record was changed or removed. If DNS no longer points to Stasher News, the domain may need to be re-verified.

### I changed my turf ownership or let the turf expire

You may need to repeat domain verification. Some certificate and verification records may be cleared for safety when turf ownership or status changes.

## Private beta notes

Custom domains are still in beta. Behavior, settings, and verification steps may change before the feature is generally available.

If you run into problems, contact the Stasher News team with:

* your Stasher News nym
* your turf name
* the custom domain you are trying to use
* a screenshot of the current domain status
* your DNS provider, if relevant

