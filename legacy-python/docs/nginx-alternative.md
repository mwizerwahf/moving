# If the server already runs nginx on ports 80 and 443

Caddy and an existing nginx cannot both listen on ports 80 and 443. If mwizerwa.com is already
served by nginx on the same server, let nginx handle car.mwizerwa.com too:

1. In `docker-compose.yml`, delete the whole `caddy:` service (and the `caddy_data` and
   `caddy_config` volumes), and give the app a port on the loopback address only:

   ```yaml
     app:
       ...
       ports:
         - "127.0.0.1:8000:8000"
   ```

2. Add this server block, for example `/etc/nginx/sites-available/car.mwizerwa.com`, then
   `sudo ln -s /etc/nginx/sites-available/car.mwizerwa.com /etc/nginx/sites-enabled/`:

   ```nginx
   server {
       listen 80;
       server_name car.mwizerwa.com;
       client_max_body_size 256k;

       location / {
           proxy_pass http://127.0.0.1:8000;
           proxy_set_header Host $host;
           proxy_set_header X-Forwarded-For $remote_addr;   # not $proxy_add_x_forwarded_for: clients could fake it
           proxy_set_header X-Forwarded-Proto $scheme;
           proxy_http_version 1.1;
           proxy_buffering off;          # live stream
           proxy_read_timeout 1h;        # live stream
       }
   }
   ```

3. Get the certificate and switch the block to HTTPS automatically:

   ```sh
   sudo nginx -t && sudo systemctl reload nginx
   sudo certbot --nginx -d car.mwizerwa.com --redirect
   ```

4. Add `add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;`
   inside the `listen 443` block certbot created, and reload nginx.
