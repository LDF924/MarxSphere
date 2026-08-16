import sys
model = sys.argv[1]

with open(r"%USERPROFILE%\import_graphiti.py", "r", encoding="utf-8") as f:
    content = f.read()

# Replace model name in the config section (line ~102-103)
old = content
content = content.replace(
    'model="' + old.split('model="')[1].split('"')[0] + '"',
    f'model="{model}"'
)
# The small_model line also needs updating  
# Actually easier: just replace both occurrences

lines = content.split('\n')
new_lines = []
for line in lines:
    if 'model=' in line and 'embedding_model' not in line and 'api_key' not in line and 'openai' not in line and 'LLM=' not in line:
        if 'model="qwen' in line:
            line = line.replace(line.split('"')[1], model)
            # Also fix second quote
            parts = line.split('"')
            # The model name is in parts[1], small_model in parts[3]
            line = f'{parts[0]}"{model}"{parts[2]}"{model}"'
    
    new_lines.append(line)

with open(r"%USERPROFILE%\import_graphiti.py", "w", encoding="utf-8") as f:
    f.write('\n'.join(new_lines))

print(f"Switched to {model}")
