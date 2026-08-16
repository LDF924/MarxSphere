import os
import sys
sys.path.insert(0, os.environ.get('GRAPHITI_SKILL_DIR', ''))
from mcp_server.server import mcp
mcp.run(transport="stdio")
