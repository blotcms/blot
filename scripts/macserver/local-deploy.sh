scp -r ./app/clients localmacserver:~/blot/app/

ssh localmacserver "export NVM_DIR=\"\$HOME/.nvm\" && [ -s \"\$NVM_DIR/nvm.sh\" ] && \. \"\$NVM_DIR/nvm.sh\" && cd ~/blot/app/clients/icloud/macserver && rm package-lock.json && rm -rf node_modules && npm install && pm2 restart macserver"