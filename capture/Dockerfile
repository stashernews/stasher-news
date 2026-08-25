FROM ghcr.io/puppeteer/puppeteer:25.9.0

EXPOSE 5678

USER root
WORKDIR /home/pptruser

ENV PUPPETEER_SKIP_DOWNLOAD true
COPY ./package*.json ./
RUN npm ci

COPY . .

ADD https://deb.debian.org/debian/pool/main/f/fonts-noto-color-emoji/fonts-noto-color-emoji_0~20200916-1_all.deb fonts-noto-color-emoji.deb
RUN dpkg -i fonts-noto-color-emoji.deb
# images >= v22 dropped the google-chrome-stable apt package; Chrome-for-Testing
# lives in the pptruser cache. capture/index.js launches 'google-chrome-stable',
# so bridge it with a symlink (glob re-resolves at every image bump rebuild).
# The --version guard fails the build loudly if the cache layout ever drifts
# (a literal glob would otherwise build green while screenshots 500 silently).
RUN ln -s /home/pptruser/.cache/puppeteer/chrome/linux-*/chrome-linux64/chrome /usr/local/bin/google-chrome-stable && google-chrome-stable --version >/dev/null
CMD [ "node", "index.js" ]
USER pptruser
