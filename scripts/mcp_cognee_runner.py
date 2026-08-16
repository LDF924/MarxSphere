import os
import sys, os
sys.path.insert(0, os.environ.get('COGNEE_DIR', ''))
os.chdir(os.environ.get('COGNEE_DIR', ''))
from mcp_server.server import mcp
mcp.run(transport="stdio")
