# Modernized implementation of the pskmap.html page

This isn't a full featured replacement, and it needs design work, but it is a step forward. In particular, it no longer
serves tiles from the pskreporter server, but from a public map tile server. I have only tested this on my macbook so 
I don't know what the performance will be like on other platforms -- especially mobile. 

This uses `vite` for building and serving locally.

Change into your new `pskreporter` directory and start a development server (available at http://localhost:5173):

    cd pskreporter
    npm start

To generate a build ready for production:

    npm run build

Then deploy the contents of the `dist` directory to your server.  You can also run `npm run serve` to serve the results of the `dist` directory for preview.
