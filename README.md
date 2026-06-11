cd backend-node
npm install
.env & .env.local add the keys       

# add AWS keys to .aws.local also

# 1) analyse a folder of files (drop all your scans/pentests in one folder)
./run-cli.sh ../sample-reports          # Windows: run-cli.bat ..\sample-reports

# 2) serve the result to the dashboard
./run-backend-local.sh                  # Windows: run-backend-local.bat

# 3) front end, new terminal
cd ../frontend && npm install && npm run dev
