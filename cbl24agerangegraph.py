import matplotlib.pyplot as plt
import pandas as pd
import glob
import os

# ── Load all files ──────────────────────────────────────────────────────
folder = r'C:\Users\marti\Downloads\3f86fc072dd3028c87c34b944919c28f533f59d3'
all_files = glob.glob(os.path.join(folder, '**', '*stop-and-search*.csv'), recursive=True)

dfs = []
for f in all_files:
    temp = pd.read_csv(f)
    dfs.append(temp)

df = pd.concat(dfs, ignore_index=True)

# ── Define NFA ──────────────────────────────────────────────────────────
df['is_nfa'] = df['Outcome'] == 'A no further action disposal'

# ── Group by age range ──────────────────────────────────────────────────
table = (
    df.dropna(subset=['Age range'])
      .groupby('Age range')['is_nfa']
      .agg(['count', 'sum', 'mean'])
      .rename(columns={
          'count': 'Total Searches',
          'sum': 'NFA Count',
          'mean': 'NFA Rate'
      })
)

table['NFA %'] = (table['NFA Rate'] * 100).round(1)

# ── Logical order ───────────────────────────────────────────────────────
age_order = ['under 10', '10-17', '18-24', '25-34', 'over 34']
table = table.reindex([x for x in age_order if x in table.index])

# ── Keep final columns ──────────────────────────────────────────────────
table = table[['Total Searches', 'NFA Count', 'NFA %']]

# ── Plot table chart ────────────────────────────────────────────────────
fig, ax = plt.subplots(figsize=(9,3.8))
ax.axis('off')

cell_data = table.reset_index().values.tolist()

tbl = ax.table(
    cellText=cell_data,
    colLabels=['Age Range', 'Total Searches', 'NFA Count', 'NFA %'],
    loc='center',
    cellLoc='center'
)

tbl.auto_set_font_size(False)
tbl.set_fontsize(11)
tbl.scale(1.2, 2)

# Header styling
for j in range(4):
    tbl[0, j].set_facecolor('#2C3E50')
    tbl[0, j].set_text_props(color='white', fontweight='bold')

# Shade rows by NFA %
nfa_vals = table['NFA %'].values
min_v, max_v = nfa_vals.min(), nfa_vals.max()

for i, val in enumerate(nfa_vals):
    intensity = (val - min_v) / (max_v - min_v) if max_v != min_v else 0.5
    colour = (
        1,
        1 - intensity * 0.35,
        1 - intensity * 0.35
    )
    for j in range(4):
        tbl[i + 1, j].set_facecolor(colour)

ax.set_title(
    'No Further Action (NFA) Rate by Age Range\n(All Forces)',
    fontsize=13,
    fontweight='bold',
    pad=20
)

plt.tight_layout()
plt.savefig('nfa_by_age_table.png', dpi=150, bbox_inches='tight')
plt.show()

print("Saved as nfa_by_age_table.png")