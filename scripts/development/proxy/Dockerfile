# Use the nginx:alpine image as the base image
FROM nginx:alpine

# Set working directory
WORKDIR /etc/nginx

# Copy the custom Nginx configuration file into the container
COPY ./development_server.conf /etc/nginx/nginx.conf
COPY ./502.html /usr/share/nginx/html/502.html

# Copy init script
COPY ./init.sh /etc/nginx/init.sh