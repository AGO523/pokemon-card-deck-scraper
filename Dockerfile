FROM node:14-slim

RUN apt-get update && apt-get install -y wget ca-certificates fonts-liberation libappindicator3-1 xdg-utils \
    libasound2 libatk-bridge2.0-0 libnspr4 libnss3 libxss1 lsb-release xdg-utils libatk1.0-0 libgtk-3-0 libgbm-dev

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

CMD ["node", "app.js"]

EXPOSE 3000
