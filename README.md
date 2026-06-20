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


for code security
go to folder code-secaudit-anthropic-model
run the commands
node bin\secaudit.js "C:\path\to\customer-code" --dry-run        # free, lists files
###This  will genrate the security report
node bin\secaudit.js "C:\path\to\customer-code" -m sonnet-4.5,opus-4.6,fable-5


---- Ccode analysis with TM


npm install
node bin\secaudit.js "C:\path\to\code" -m sonnet-4.5,opus-4.6     # recommended for production
node bin\secaudit.js "C:\path\to\code" --threat-models stride,attack   # pick passes
node bin\secaudit.js "C:\path\to\code" --no-threat-model               # code findings only


