# Script for importing Discord forum channel content into Discourse

This script assumes you have run the [discord-export](../discord-export/README.md) script to export data from Discord into a local database. 

**Run this script on a development server**, then move the data to your actual server using the [official instructions](https://meta.discourse.org/t/migrate-from-another-forum-to-discourse/16616).

# How to run
Note that for these steps you need to enter the discourse docker in the following way first:
```console
sudo ./launcher enter app
cd /var/www/discourse
su discourse
```

- Copy the `discord.rb` script into your Discourse installations `script/import_scripts` folder. 
- Edit the database settings in `discord.rb` to match your settings. The local database location will probably be 172.17.0.1, not localhost. 
- In the Discourse root directory, 
  - Run `IMPORT=1 bundle install` to install all bundles needed by the import
  - Run `IMPORT=1 bundle exec ruby script/import_scripts/discord.rb` to perform the import
- 
